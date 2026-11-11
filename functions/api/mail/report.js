import { json } from "./_json.js";

const DAY = 864e5;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const now = Date.now();
  const from = Math.max(0, Number(url.searchParams.get("from")) || now - 7 * DAY);
  const to = Number(url.searchParams.get("to")) || now + DAY;
  const offset = Number(env.TZ_OFFSET_HOURS ?? 0) * 3600e3;
  const todayStart = Math.floor((now + offset) / DAY) * DAY - offset;
  const q = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings);

  const batches = await env.DB.batch([
    q(
      `SELECT campaign_id, MAX(campaign_name) name,
        COUNT(DISTINCT seq_id) leads,
        SUM(CASE WHEN sent_at BETWEEN ? AND ? THEN 1 ELSE 0 END) sent,
        SUM(CASE WHEN sent_at BETWEEN ? AND ? AND step_idx = 0 THEN 1 ELSE 0 END) first_sent,
        SUM(CASE WHEN sent_at BETWEEN ? AND ? AND step_idx > 0 THEN 1 ELSE 0 END) followups,
        COUNT(DISTINCT CASE WHEN status = 'bounced' AND replied_at BETWEEN ? AND ? THEN seq_id END) bounced,
        SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) queued,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed
       FROM mail_steps GROUP BY campaign_id`,
      from, to, from, to, from, to, from, to
    ),
    q(
      `SELECT campaign_id,
        COUNT(DISTINCT CASE WHEN kind = 'reply' THEN seq_id END) replied,
        COUNT(DISTINCT CASE WHEN label IN ('interested', 'meeting') THEN seq_id END) interested,
        COUNT(DISTINCT CASE WHEN label = 'unsubscribe' THEN seq_id END) unsub
       FROM mail_replies WHERE received_at BETWEEN ? AND ? GROUP BY campaign_id`,
      from, to
    ),
    q(
      `SELECT mailbox,
        SUM(CASE WHEN sent_at BETWEEN ? AND ? THEN 1 ELSE 0 END) sent,
        SUM(CASE WHEN sent_at BETWEEN ? AND ? AND step_idx = 0 THEN 1 ELSE 0 END) first_sent,
        SUM(CASE WHEN sent_at >= ? THEN 1 ELSE 0 END) today,
        COUNT(DISTINCT CASE WHEN status = 'bounced' AND replied_at BETWEEN ? AND ? THEN seq_id END) bounced,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed
       FROM mail_steps GROUP BY mailbox`,
      from, to, from, to, todayStart, from, to
    ),
    q(
      `SELECT mailbox, COUNT(DISTINCT CASE WHEN kind = 'reply' THEN seq_id END) replied
       FROM mail_replies WHERE received_at BETWEEN ? AND ? GROUP BY mailbox`,
      from, to
    ),
    q(
      `SELECT step_idx, COUNT(*) sent FROM mail_steps
       WHERE sent_at BETWEEN ? AND ? GROUP BY step_idx`,
      from, to
    ),
    q(
      `SELECT step_idx, COUNT(DISTINCT seq_id) replied FROM mail_replies
       WHERE kind = 'reply' AND received_at BETWEEN ? AND ? AND step_idx IS NOT NULL
       GROUP BY step_idx`,
      from, to
    ),
    q(
      `SELECT strftime('%Y-%m-%d', (sent_at + ?) / 1000, 'unixepoch') d,
        COUNT(*) sent, SUM(CASE WHEN step_idx > 0 THEN 1 ELSE 0 END) followups
       FROM mail_steps WHERE sent_at BETWEEN ? AND ? GROUP BY d`,
      offset, from, to
    ),
    q(
      `SELECT strftime('%Y-%m-%d', (received_at + ?) / 1000, 'unixepoch') d,
        COUNT(DISTINCT seq_id) replies
       FROM mail_replies WHERE kind = 'reply' AND received_at BETWEEN ? AND ? GROUP BY d`,
      offset, from, to
    ),
    q("SELECT COUNT(*) n FROM mail_steps WHERE sent_at >= ?", todayStart)
  ]);

  const [campaignRows, campaignReplies, mailboxRows, mailboxReplies, stepSent, stepReplies, daySent, dayReplies, today] =
    batches.map((batch) => batch.results);
  const by = (rows, key) => Object.fromEntries(rows.map((row) => [row[key], row]));
  const campaignReplyMap = by(campaignReplies, "campaign_id");
  const mailboxReplyMap = by(mailboxReplies, "mailbox");
  const stepReplyMap = by(stepReplies, "step_idx");
  const campaigns = campaignRows.map((row) => ({
    ...row,
    replied: campaignReplyMap[row.campaign_id]?.replied || 0,
    interested: campaignReplyMap[row.campaign_id]?.interested || 0,
    unsub: campaignReplyMap[row.campaign_id]?.unsub || 0
  }));
  const mailboxes = mailboxRows.map((row) => ({
    ...row,
    replied: mailboxReplyMap[row.mailbox]?.replied || 0
  }));
  const steps = stepSent.map((row) => ({
    step_idx: row.step_idx,
    sent: row.sent,
    replied: stepReplyMap[row.step_idx]?.replied || 0
  }));
  const days = {};
  daySent.forEach((row) => (days[row.d] = { d: row.d, sent: row.sent, followups: row.followups, replies: 0 }));
  dayReplies.forEach((row) => {
    days[row.d] = days[row.d] || { d: row.d, sent: 0, followups: 0, replies: 0 };
    days[row.d].replies = row.replies;
  });
  const sum = (key) => campaigns.reduce((total, row) => total + (row[key] || 0), 0);

  return json({
    range: { from, to },
    caps: {
      total: Number(env.TOTAL_DAILY_CAP || 500),
      mailbox: Number(env.MAILBOX_DAILY_CAP || 20)
    },
    today: { sent: today[0]?.n || 0 },
    totals: {
      sent: sum("sent"),
      first_sent: sum("first_sent"),
      followups: sum("followups"),
      replied: sum("replied"),
      interested: sum("interested"),
      unsub: sum("unsub"),
      bounced: sum("bounced"),
      queued: sum("queued"),
      failed: sum("failed")
    },
    campaigns,
    mailboxes,
    steps,
    daily: Object.values(days).sort((a, b) => a.d.localeCompare(b.d))
  });
}
