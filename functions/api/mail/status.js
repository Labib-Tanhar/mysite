import { json } from "./_json.js";

export async function onRequestGet({ request, env }) {
  const ids = new URL(request.url).searchParams
    .get("seq")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 100) || [];

  const columns = "id, seq_id, step_idx, mailbox, to_addr, subject, send_at, status, sent_at, replied_at, error";
  const query = ids.length
    ? env.DB.prepare(
        `SELECT ${columns} FROM mail_steps WHERE seq_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq_id, step_idx`
      ).bind(...ids)
    : env.DB.prepare(
        `SELECT ${columns} FROM mail_steps WHERE send_at > ? ORDER BY seq_id, step_idx LIMIT 2000`
      ).bind(Date.now() - 90 * 864e5);

  const { results } = await query.all();
  return json(results);
}
