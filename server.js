import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    estimateMinutes: { type: "integer", minimum: 1, maximum: 480 },
    operation: { type: "string", enum: ["create", "delete", "update", "noop"] },
    rationale: { type: "string" },
    coaching: { type: "string" },
    memory: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          priority: { type: "string", enum: ["High", "Medium", "Low"] },
          action: { type: "string", enum: ["create", "delete", "update", "keep"] }
        },
        required: ["name", "priority", "action"]
      }
    }
  },
  required: ["summary", "estimateMinutes", "operation", "rationale", "coaching", "memory", "tasks"]
};

app.post("/api/agent", async (req, res) => {
  const { message = "", snapshot = {}, preferences = {} } = req.body || {};
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "NVIDIA_NIM_API_KEY is not configured on the server." });
  }

  const model = process.env.NVIDIA_NIM_MODEL || "mistralai/mistral-large-2-instruct";
  const system = [
    "You are Atelier Agent, a pragmatic business operating companion.",
    "Use only the supplied Firestore snapshot. Never invent business facts.",
    "You may recommend task changes, but the client must approve them before any write.",
    "Be direct, motivating, and respectful. Do not shame the user or make threats.",
    "Return valid JSON matching the provided schema. Estimate the work in minutes.",
    "If the user asks for an action unrelated to tasks, explain that it needs a future integration."
  ].join(" ");

  const prompt = JSON.stringify({ message, snapshot, preferences });
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `NIM request failed: ${text.slice(0, 500)}` });
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: "NIM returned no plan." });
    const plan = JSON.parse(content);
    return res.json({ plan, model });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Agent request failed." });
  }
});

app.get("*splat", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(port, () => console.log(`Atelier Agent listening on http://localhost:${port}`));
