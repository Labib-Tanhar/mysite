# Atelier Agent

An approval-first agentic business console for Firebase/Firestore and NVIDIA NIM.

## Run locally

```bash
npm install
NVIDIA_NIM_API_KEY=... npm start
```

Open `http://localhost:3000`. Add the Firebase Web SDK config in **Settings**. The browser stores that public config locally; the NVIDIA key stays on the server.

## Firestore collections

- `tasks`: task name, priority, completion state, timestamps
- `agentMemory`: durable user preferences and context

Use Firebase Authentication and per-user Firestore rules before production. The agent can propose task creation, updates, and deletion, but the browser always displays an estimated duration and requires explicit approval before applying mutations.

## Microsoft 365 campaigns

The campaign screen can queue CSV leads into the Cloudflare mail API and show the aggregated report in the same view. The supported CSV columns are:

```csv
email,name,company,mailbox
lead@example.com,Ali,Acme,hello@labibatelier.com
```

### One-time setup

1. In Microsoft Entra ID, register an app for the tenant that owns the mailboxes. Add Microsoft Graph **Application** permissions `Mail.Send`, `Mail.Read`, and `Mail.ReadBasic`; grant admin consent. Create a client secret and keep it private.
2. Create the D1 database and apply `db/schema.sql`:

   ```bash
   npx wrangler d1 create atelier-mail
   npx wrangler d1 execute atelier-mail --remote --file=db/schema.sql
   ```

   Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.toml`.
3. Configure the Worker and Pages Function secrets. Do not commit these values:

   ```bash
   npx wrangler secret put ATELIER_TOKEN
   npx wrangler secret put MS_TENANT_ID
   npx wrangler secret put MS_CLIENT_ID
   npx wrangler secret put MS_CLIENT_SECRET
   npx wrangler secret put ALLOWED_MAILBOXES
   ```

   Set the same `ATELIER_TOKEN`, `ALLOWED_MAILBOXES`, and D1 binding on the Pages project. List all 25 mailbox addresses in `ALLOWED_MAILBOXES`, comma-separated.
4. Deploy the Worker with `npx wrangler deploy`, then deploy the Pages project so `/api/mail/*` is available on the same origin. The Worker polls replies and sends every five minutes.
5. Open **Campaigns & reports → Connect Microsoft**, paste the Pages `ATELIER_TOKEN`, import the CSV, review every mailbox assignment, then click **Launch sending**.

The Worker enforces a hard aggregate limit of 500 sent messages per day and a default limit of 20 per mailbox (25 mailboxes × 20 = 500). Replies, bounces, unsubscribes, follow-ups, mailbox activity, and failures appear in the report. Test with one mailbox and one internal recipient before adding the remaining mailboxes.
