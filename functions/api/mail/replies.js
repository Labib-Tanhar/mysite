import { json } from "./_json.js";

const labels = ["", "interested", "meeting", "not_interested", "unsubscribe"];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "new";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 300);
  const where = {
    new: "kind = 'reply' AND seen = 0",
    replies: "kind = 'reply'",
    interested: "label IN ('interested', 'meeting')",
    other: "kind IN ('bounce', 'auto')"
  }[view] || "kind = 'reply'";

  const [rows, unseen] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, seq_id, campaign_id, mailbox, from_addr, from_name, subject,
        snippet, received_at, kind, step_idx, label, seen
       FROM mail_replies WHERE ${where} ORDER BY received_at DESC LIMIT ?`
    ).bind(limit),
    env.DB.prepare("SELECT COUNT(*) n FROM mail_replies WHERE kind = 'reply' AND seen = 0")
  ]);

  return json({ rows: rows.results, unseen: unseen.results[0]?.n || 0 });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => null);
  if (!body?.id) return json({ error: "Reply id is required" }, 400);

  const reply = await env.DB.prepare("SELECT id, seq_id FROM mail_replies WHERE id = ?").bind(body.id).first();
  if (!reply) return json({ error: "Reply not found" }, 404);

  const statements = [];
  if (typeof body.label === "string") {
    if (!labels.includes(body.label)) return json({ error: "Invalid label" }, 400);
    statements.push(
      env.DB.prepare("UPDATE mail_replies SET label = ?, seen = 1 WHERE id = ?").bind(body.label, body.id)
    );
    if (body.label === "unsubscribe") {
      const lead = await env.DB.prepare("SELECT to_addr FROM mail_steps WHERE seq_id = ? LIMIT 1").bind(reply.seq_id).first();
      if (lead) {
        statements.push(
          env.DB.prepare(
            "INSERT OR REPLACE INTO mail_suppress (email, reason, at) VALUES (?, ?, ?)"
          ).bind(lead.to_addr, "unsubscribe", Date.now()),
          env.DB.prepare("UPDATE mail_steps SET status = 'cancelled' WHERE seq_id = ? AND status = 'scheduled'")
            .bind(reply.seq_id)
        );
      }
    }
  }
  if (body.seen !== undefined) {
    statements.push(
      env.DB.prepare("UPDATE mail_replies SET seen = ? WHERE id = ?").bind(body.seen ? 1 : 0, body.id)
    );
  }

  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true });
}
