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
