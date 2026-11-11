import { json } from "./_json.js";

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const seqId = String(body.seqId || "").trim();
  if (!seqId) return json({ error: "seqId is required" }, 400);

  const result = await env.DB
    .prepare("UPDATE mail_steps SET status = 'cancelled' WHERE seq_id = ? AND status = 'scheduled'")
    .bind(seqId)
    .run();

  return json({ ok: true, cancelled: result.meta.changes });
}
