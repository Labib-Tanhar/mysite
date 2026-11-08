import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy, updateDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const state = { tasks: [], memories: [], config: null, db: null, unsubs: [], settings: JSON.parse(localStorage.getItem("atelier-settings") || "{}"), lastPlan: null };
const fallbackTasks = JSON.parse(localStorage.getItem("atelier-tasks") || "[]");
state.tasks = fallbackTasks;
state.memories = JSON.parse(localStorage.getItem("atelier-memory") || "[]");

function esc(value) { const el = document.createElement("span"); el.textContent = value ?? ""; return el.innerHTML; }
function saveLocal() { localStorage.setItem("atelier-tasks", JSON.stringify(state.tasks)); localStorage.setItem("atelier-memory", JSON.stringify(state.memories)); }
function toast(message) { $("settings-status").textContent = message; setTimeout(() => { if ($("settings-status").textContent === message) $("settings-status").textContent = ""; }, 3000); }
function snapshot() { return { tasks: state.tasks, memory: state.memories, metrics: { completed: state.tasks.filter(t => t.completed).length, active: state.tasks.filter(t => !t.completed).length }, preferences: state.settings }; }

function render() {
  const total = state.tasks.length, completed = state.tasks.filter(t => t.completed).length, active = total - completed;
  const rate = total ? Math.round(completed / total * 100) : 0;
  $("completion-rate").textContent = `${rate}%`; $("completion-progress").style.width = `${rate}%`;
  $("completion-copy").textContent = total ? `${completed} of ${total} tasks completed` : "No tasks yet";
  $("active-count").textContent = active;
  const target = Number(state.settings.goalTarget || 10), goal = Math.min(100, Math.round(completed / target * 100));
  $("goal-rate").textContent = `${goal}%`; $("goal-progress").style.width = `${goal}%`;
  $("goal-copy").textContent = `${completed}/${target} ${state.settings.goalUnit || "completed tasks"}`;
  $("streak").textContent = completed ? Math.min(completed, 9) : 0;
  $("task-list").innerHTML = state.tasks.length ? state.tasks.map((t) => `<div class="task-row ${t.completed ? "done" : ""}"><button class="check ${t.completed ? "done" : ""}" data-toggle="${t.id}" aria-label="Toggle task"></button><span class="task-name">${esc(t.name)}</span><span class="priority ${t.priority.toLowerCase()}">${esc(t.priority)}</span><button class="delete" data-delete="${t.id}" aria-label="Delete task">×</button></div>`).join("") : `<div class="panel muted">No tasks yet. Ask the agent to create a focused mission.</div>`;
  $("memory-list").innerHTML = state.memories.length ? state.memories.map((m, i) => `<div class="memory-row"><span class="pill purple">MEMORY</span><p>${esc(m.text)}</p><button class="delete" data-memory="${i}">×</button></div>`).join("") : `<div class="panel muted">The agent has no saved context yet.</div>`;
  const bars = Array.from({ length: 7 }, (_, i) => Math.min(100, (state.tasks.filter(t => t.completed).length * (i + 2) * 7) % 100));
  $("bar-chart").innerHTML = bars.map((n, i) => `<div class="bar" style="height:${n || 4}%"><label>${["M","T","W","T","F","S","S"][i]}</label></div>`).join("");
}

function renderPlan(plan) {
  state.lastPlan = plan;
  $("agent-coaching").textContent = plan.coaching;
  $("queue-time").textContent = `~${plan.estimateMinutes} min`;
  const changes = (plan.tasks || []).filter(t => t.action !== "keep");
  $("priority-queue").classList.remove("empty");
  $("priority-queue").innerHTML = changes.length ? changes.map((t, i) => `<div class="queue-item"><span class="rank">0${i + 1}</span><div><p>${esc(t.name)}</p><small>${esc(t.action)} · ${esc(t.priority)} priority</small></div></div>`).join("") : `<div class="queue-item"><span class="rank">✦</span><div><p>No task changes recommended.</p><small>${esc(plan.summary)}</small></div></div>`;
}

async function askAgent(message) {
  addBubble(message, "user");
  addBubble("Scanning your workspace and estimating the next move…", "agent");
  try {
    const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, snapshot: snapshot(), preferences: state.settings }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Agent unavailable");
    const bubbles = [...$("chat-log").children]; bubbles.at(-1).remove();
    addBubble(`${data.plan.summary} Estimated time: ${data.plan.estimateMinutes} minutes.`, "agent");
    renderPlan(data.plan);
    if (data.plan.operation !== "noop" && (data.plan.tasks || []).some(t => t.action !== "keep")) showProposal(data.plan);
    if (data.plan.memory?.trim()) await remember(data.plan.memory.trim());
  } catch (error) {
    const bubbles = [...$("chat-log").children]; bubbles.at(-1)?.remove();
    addBubble(error.message, "agent");
  }
}
function addBubble(text, type) { const el = document.createElement("div"); el.className = `bubble ${type}`; el.textContent = text; $("chat-log").append(el); $("chat-log").scrollTop = $("chat-log").scrollHeight; }
function showProposal(plan) {
  const changes = plan.tasks.filter(t => t.action !== "keep");
  $("modal-root").innerHTML = `<div class="modal-backdrop"><div class="modal"><span class="pill purple">APPROVAL REQUIRED</span><h3>Ready to change your task board?</h3><p>${esc(plan.rationale)}</p><div class="proposal"><strong>Estimated work: ${plan.estimateMinutes} minutes</strong><ul>${changes.map(t => `<li><b>${esc(t.action.toUpperCase())}</b> · ${esc(t.name)} (${esc(t.priority)})</li>`).join("")}</ul></div><div class="modal-actions"><button class="secondary" id="deny-plan">Not now</button><button class="primary" id="approve-plan">Approve changes</button></div></div></div>`;
  $("deny-plan").onclick = () => $("modal-root").innerHTML = "";
  $("approve-plan").onclick = async () => { await applyPlan(plan); $("modal-root").innerHTML = ""; addBubble("Approved. I applied the task changes and saved the context.", "agent"); };
}
async function applyPlan(plan) {
  for (const item of plan.tasks.filter(t => t.action !== "keep")) {
    if (item.action === "create") await createTask(item.name, item.priority);
    if (item.action === "delete" && item.id) await removeTask(item.id);
    if (item.action === "update" && item.id) await updateTask(item.id, { name: item.name, priority: item.priority });
  }
}
async function createTask(name, priority = "Medium") {
  const task = { name, priority, completed: false, createdAt: new Date().toISOString() };
  if (state.db) await addDoc(collection(state.db, "tasks"), task); else { state.tasks.unshift({ ...task, id: crypto.randomUUID() }); saveLocal(); render(); }
}
async function removeTask(id) { if (state.db) await deleteDoc(doc(state.db, "tasks", id)); else { state.tasks = state.tasks.filter(t => t.id !== id); saveLocal(); render(); } }
async function updateTask(id, patch) { if (state.db) await updateDoc(doc(state.db, "tasks", id), patch); else { const t = state.tasks.find(x => x.id === id); if (t) Object.assign(t, patch); saveLocal(); render(); } }
async function remember(text) {
  if (state.memories.some(m => m.text === text)) return;
  const memory = { text, createdAt: new Date().toISOString() };
  if (state.db) await addDoc(collection(state.db, "agentMemory"), memory); else { state.memories.unshift({ ...memory, id: crypto.randomUUID() }); saveLocal(); render(); }
}
async function connectFirebase(config) {
  try {
    const app = initializeApp(config); state.db = getFirestore(app); $("connection-label").textContent = "Firestore connected";
    state.unsubs.push(onSnapshot(query(collection(state.db, "tasks"), orderBy("createdAt", "desc")), (snap) => { state.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }));
    state.unsubs.push(onSnapshot(query(collection(state.db, "agentMemory"), orderBy("createdAt", "desc")), (snap) => { state.memories = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }));
  } catch (error) { $("connection-label").textContent = "Local mode"; toast(`Firebase connection failed: ${error.message}`); }
}

document.querySelectorAll(".nav-link").forEach((button) => button.onclick = () => { document.querySelectorAll(".nav-link").forEach(b => b.classList.remove("active")); button.classList.add("active"); document.querySelectorAll(".view").forEach(v => v.classList.remove("active")); $(`view-${button.dataset.view}`).classList.add("active"); $("page-title").textContent = button.dataset.view === "dashboard" ? "Command center" : button.textContent.trim(); });
$("chat-form").onsubmit = (e) => { e.preventDefault(); const input = $("chat-input"); const message = input.value.trim(); if (message) { input.value = ""; askAgent(message); } };
$("ask-focus").onclick = () => askAgent("Scan my database and tell me the single highest-leverage task I should do next. Create it only if I approve.");
$("new-task").onclick = () => { const name = prompt("What task should I add?"); if (name?.trim()) createTask(name.trim()); };
$("task-list").onclick = async (e) => { const toggle = e.target.closest("[data-toggle]"), del = e.target.closest("[data-delete]"); if (toggle) { const task = state.tasks.find(t => t.id === toggle.dataset.toggle); if (task) await updateTask(task.id, { completed: !task.completed, completedAt: new Date().toISOString() }); } if (del) showProposal({ summary: "Delete task", estimateMinutes: 1, rationale: "You asked to delete this task.", coaching: "Keep the board honest.", memory: "", operation: "delete", tasks: [{ id: del.dataset.delete, name: state.tasks.find(t => t.id === del.dataset.delete)?.name || "Selected task", priority: "Medium", action: "delete" }] }); };
$("memory-form").onsubmit = async (e) => { e.preventDefault(); const input = $("memory-input"); if (input.value.trim()) { await remember(input.value.trim()); input.value = ""; } };
$("memory-list").onclick = async (e) => { const button = e.target.closest("[data-memory]"); if (!button) return; const memory = state.memories[Number(button.dataset.memory)]; if (state.db && memory?.id) await deleteDoc(doc(state.db, "agentMemory", memory.id)); else { state.memories.splice(Number(button.dataset.memory), 1); saveLocal(); render(); } };
$("save-settings").onclick = async () => { try { state.settings = { ...state.settings, ...JSON.parse($("firebase-config").value || "{}"), goalTarget: Number($("goal-target").value), goalUnit: $("goal-unit").value }; localStorage.setItem("atelier-settings", JSON.stringify(state.settings)); if (state.settings.projectId && !state.db) await connectFirebase(state.settings); toast("Settings saved."); render(); } catch { toast("Firebase config must be valid JSON."); } };
if (state.settings.projectId) { $("firebase-config").value = JSON.stringify(state.settings, null, 2); $("goal-target").value = state.settings.goalTarget || 10; $("goal-unit").value = state.settings.goalUnit || "completed tasks"; connectFirebase(state.settings); }
render();
