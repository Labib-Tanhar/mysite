import { graph } from "./graph.js";

const DAY = 864e5;
const encode = encodeURIComponent;
const recipient = (address) => [{ emailAddress: { address } }];
const html = (text) =>
  `<div>${String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>")}</div>`;

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(run(env));
  },
  async fetch(request, env) {
    if (!env.ATELIER_TOKEN || request.headers.get("x-atelier-token") !== env.ATELIER_TOKEN) {
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json(await run(env));
  }
};

async function run(env) {
  const replies = await pollReplies(env).catch((error) => ({ error: String(error) }));
  const sends = await sendDue(env).catch((error) => ({ error: String(error) }));
  return { replies, sends };
}

function openWindow(env, now) {
  const local = new Date(now + Number(env.TZ_OFFSET_HOURS || 0) * 3600e3);
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const [start, end] = String(env.SEND_WINDOW || "9-17").split("-").map(Number);
  const days = String(env.SEND_DAYS || "1,2,3,4,5").split(",").map(Number);
  return days.includes(local.getUTCDay()) && hour >= start && hour < end;
}

async function sendDue(env) {
  const mailboxCap = Number(env.MAILBOX_DAILY_CAP || 20);
  const totalCap = Number(env.TOTAL_DAILY_CAP || 500);
  const perRun = Number(env.SEND_PER_RUN || 10);
  const now = Date.now();
  const offset = Number(env.TZ_OFFSET_HOURS || 0) * 3600e3;
  const dayStart = Math.floor((now + offset) / DAY) * DAY - offset;
  const result = { sent: 0, failed: 0, deferred: 0 };
  if (!openWindow(env, now)) return { ...result, note: "outside sending window" };

  const usedRows = (
    await env.DB.prepare("SELECT mailbox, COUNT(*) n FROM mail_steps WHERE sent_at >= ? GROUP BY mailbox")
      .bind(dayStart)
      .all()
  ).results;
  const used = Object.fromEntries(usedRows.map((row) => [row.mailbox, row.n]));
  let total = usedRows.reduce((sum, row) => sum + row.n, 0);
  if (total >= totalCap) return { ...result, note: "daily total reached" };

  const full = Object.keys(used).filter((mailbox) => used[mailbox] >= mailboxCap);
  const room = Math.min(perRun, totalCap - total);
  const excluded = full.length ? `AND s.mailbox NOT IN (${full.map(() => "?").join(",")})` : "";
  const due = (
    await env.DB.prepare(`
      SELECT s.* FROM mail_steps s
      LEFT JOIN mail_steps previous ON previous.seq_id = s.seq_id
        AND previous.step_idx = (
          SELECT MAX(p.step_idx) FROM mail_steps p
          WHERE p.seq_id = s.seq_id AND p.step_idx < s.step_idx
        )
      WHERE s.status = 'scheduled' AND s.send_at <= ?
        AND s.to_addr NOT IN (SELECT email FROM mail_suppress)
        AND (s.step_idx = 0 OR (
          previous.sent_at IS NOT NULL AND
          ? >= previous.sent_at + MAX(?, s.send_at - previous.send_at)
        ))
        ${excluded}
      ORDER BY s.send_at
      LIMIT ?
    `)
      .bind(now, now, DAY, ...full, room)
      .all()
  ).results;

  for (const step of due) {
    if ((used[step.mailbox] || 0) >= mailboxCap || total >= totalCap) {
      result.deferred++;
      continue;
    }
    const claimed = await env.DB.prepare(
      "UPDATE mail_steps SET status = 'sending' WHERE id = ? AND status = 'scheduled'"
    ).bind(step.id).run();
    if (claimed.meta.changes !== 1) continue;

    try {
      const sent = step.step_idx === 0 ? await sendFirst(env, step) : await sendFollowUp(env, step);
      await env.DB.prepare(
        `UPDATE mail_steps SET status = 'sent', sent_at = ?, message_id = ?,
          conversation_id = ?, error = NULL WHERE id = ?`
      ).bind(Date.now(), sent.id, sent.conversationId, step.id).run();
      used[step.mailbox] = (used[step.mailbox] || 0) + 1;
      total++;
      result.sent++;
    } catch (error) {
      await env.DB.prepare("UPDATE mail_steps SET status = 'failed', error = ? WHERE id = ?")
        .bind(String(error).slice(0, 500), step.id).run();
      result.failed++;
    }
  }
  return result;
}

async function sendFirst(env, step) {
  const user = encode(step.mailbox);
  const draft = await graph(env, "POST", `/users/${user}/messages`, {
    subject: step.subject,
    body: { contentType: "HTML", content: html(step.body) },
    toRecipients: recipient(step.to_addr)
  });
  await graph(env, "POST", `/users/${user}/messages/${encode(draft.id)}/send`);
  return { id: draft.id, conversationId: draft.conversationId };
}

async function sendFollowUp(env, step) {
  const previous = await env.DB.prepare(
    `SELECT message_id, conversation_id FROM mail_steps
     WHERE seq_id = ? AND status = 'sent' AND message_id IS NOT NULL
     ORDER BY step_idx DESC LIMIT 1`
  ).bind(step.seq_id).first();
  if (!previous) throw new Error("No earlier sent email to reply to");
  const user = encode(step.mailbox);
  const draft = await graph(env, "POST", `/users/${user}/messages/${encode(previous.message_id)}/createReply`, {
    message: { toRecipients: recipient(step.to_addr), body: { contentType: "HTML", content: html(step.body) } }
  });
  await graph(env, "POST", `/users/${user}/messages/${encode(draft.id)}/send`);
  return { id: draft.id, conversationId: draft.conversationId || previous.conversation_id };
}

async function pollReplies(env) {
  const started = Date.now();
  const result = { recorded: 0, errors: [] };
  const boxes = (
    await env.DB.prepare("SELECT DISTINCT mailbox FROM mail_steps WHERE sent_at > ?")
      .bind(started - 30 * DAY).all()
  ).results;
  const state = new Map(
    (await env.DB.prepare("SELECT mailbox, last_check FROM mail_state").all()).results.map((row) => [
      row.mailbox,
      row.last_check
    ])
  );
  const checked = [];

  for (const { mailbox } of boxes) {
    try {
      const since = new Date((state.get(mailbox) ?? started - 2 * DAY) - 10 * 60e3).toISOString();
      let next = `/users/${encode(mailbox)}/mailFolders/inbox/messages?$filter=${encode(
        `receivedDateTime ge ${since}`
      )}&$orderby=receivedDateTime%20desc&$select=id,conversationId,from,subject,bodyPreview,receivedDateTime&$top=50`;
      for (let page = 0; next && page < 5; page++) {
        const response = await graph(env, "GET", next);
        for (const message of response.value || []) result.recorded += await recordReply(env, mailbox, message);
        next = response["@odata.nextLink"];
      }
      checked.push(mailbox);
    } catch (error) {
      result.errors.push(`${mailbox}: ${String(error).slice(0, 200)}`);
    }
  }
  if (checked.length) {
    await env.DB.batch(
      checked.map((mailbox) =>
        env.DB.prepare(
          `INSERT INTO mail_state (mailbox, last_check) VALUES (?, ?)
           ON CONFLICT(mailbox) DO UPDATE SET last_check = excluded.last_check`
        ).bind(mailbox, started)
      )
    );
  }
  return result;
}

async function recordReply(env, mailbox, message) {
  const from = message.from?.emailAddress?.address?.toLowerCase() || "";
  if (!message.id || !from || from === mailbox.toLowerCase()) return 0;
  const subject = message.subject || "";
  const preview = message.bodyPreview || "";
  const auto = /^(automatic reply|auto-?reply|out of office)/i.test(subject);
  const bounce = /^(mailer-daemon|postmaster)@/.test(from) ||
    /^(undeliverable|delivery status notification|mail delivery (failed|system)|returned mail)/i.test(subject);
  const hit = message.conversationId
    ? await env.DB.prepare(
        "SELECT seq_id, campaign_id, to_addr FROM mail_steps WHERE mailbox = ? AND conversation_id = ? LIMIT 1"
      ).bind(mailbox, message.conversationId).first()
    : null;
  if (!hit) return 0;

  const kind = bounce ? "bounce" : auto ? "auto" : "reply";
  const received = Date.parse(message.receivedDateTime) || Date.now();
  const step = await env.DB.prepare(
    "SELECT MAX(step_idx) i FROM mail_steps WHERE seq_id = ? AND sent_at IS NOT NULL AND sent_at <= ?"
  ).bind(hit.seq_id, received).first();
  const unsubscribe = kind === "reply" && /\b(unsubscribe|remove me|opt[- ]?out|do not (contact|email))\b/i.test(
    `${subject} ${preview}`
  );

  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO mail_replies
       (id, seq_id, campaign_id, mailbox, from_addr, from_name, subject, snippet,
        received_at, kind, step_idx, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      message.id,
      hit.seq_id,
      hit.campaign_id || "",
      mailbox,
      from,
      message.from?.emailAddress?.name || "",
      subject.slice(0, 250),
      preview.slice(0, 400),
      received,
      kind,
      step?.i ?? null,
      unsubscribe ? "unsubscribe" : ""
    )
  ];

  if (kind !== "auto") {
    statements.push(
      env.DB.prepare("UPDATE mail_steps SET status = 'cancelled' WHERE seq_id = ? AND status = 'scheduled'")
        .bind(hit.seq_id),
      env.DB.prepare(
        "UPDATE mail_steps SET status = ?, replied_at = ? WHERE seq_id = ? AND status = 'sent'"
      ).bind(bounce ? "bounced" : "replied", received, hit.seq_id)
    );
  }
  if (bounce || unsubscribe) {
    statements.push(
      env.DB.prepare("INSERT OR REPLACE INTO mail_suppress (email, reason, at) VALUES (?, ?, ?)")
        .bind(hit.to_addr, bounce ? "bounce" : "unsubscribe", Date.now())
    );
  }
  await env.DB.batch(statements);
  return 1;
}
