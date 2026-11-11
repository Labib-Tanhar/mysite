import { json } from "./_json.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const mailbox = String(body.mailbox || "").trim().toLowerCase();
  const to = String(body.to || "").trim().toLowerCase();
  const seqId = String(body.seqId || "").trim();
  const campaignId = String(body.campaignId || seqId.split("~")[0]).slice(0, 100);
  const steps = Array.isArray(body.steps) ? body.steps.slice(0, 10) : [];
  const allowed = String(env.ALLOWED_MAILBOXES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!allowed.includes(mailbox)) return json({ error: "Mailbox is not allowed" }, 400);
  if (!emailPattern.test(to)) return json({ error: "Invalid recipient" }, 400);
  if (!/^[\w~.-]{1,100}$/.test(seqId)) return json({ error: "Invalid sequence id" }, 400);
  if (!steps.length) return json({ error: "At least one step is required" }, 400);

  for (const step of steps) {
    if (!Number.isInteger(step.idx) || step.idx < 0 || !String(step.body || "").trim()) {
      return json({ error: `Invalid step ${step.idx}` }, 400);
    }
    if (step.idx === 0 && !String(step.subject || "").trim()) {
      return json({ error: "The first step needs a subject" }, 400);
    }
    if (!Number.isFinite(Number(step.sendAt))) {
      return json({ error: `Invalid send time for step ${step.idx}` }, 400);
    }
  }

  if (await env.DB.prepare("SELECT 1 FROM mail_suppress WHERE email = ?").bind(to).first()) {
    return json({ ok: true, skipped: "suppressed" });
  }

  if (
    await env.DB
      .prepare("SELECT 1 FROM mail_steps WHERE seq_id = ? AND status IN ('replied', 'bounced') LIMIT 1")
      .bind(seqId)
      .first()
  ) {
    return json({ ok: true, skipped: "replied" });
  }

  const statement = env.DB.prepare(`
    INSERT INTO mail_steps (
      id, seq_id, campaign_id, campaign_name, step_idx, mailbox, to_addr,
      lead_name, subject, body, send_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
    ON CONFLICT(id) DO UPDATE SET
      campaign_name = excluded.campaign_name,
      mailbox = excluded.mailbox,
      to_addr = excluded.to_addr,
      lead_name = excluded.lead_name,
      subject = excluded.subject,
      body = excluded.body,
      send_at = excluded.send_at,
      status = 'scheduled',
      error = NULL
    WHERE mail_steps.status IN ('scheduled', 'cancelled', 'failed')
  `);

  await env.DB.batch(
    steps.map((step) =>
      statement.bind(
        `${seqId}:${step.idx}`,
        seqId,
        campaignId,
        String(body.campaignName || "").slice(0, 120),
        step.idx,
        mailbox,
        to,
        String(body.name || "").slice(0, 120),
        String(step.subject || "").slice(0, 250),
        String(step.body).slice(0, 20_000),
        Math.round(Number(step.sendAt))
      )
    )
  );

  return json({ ok: true, count: steps.length });
}
