// Orchestrator: start the arena, register the field, spawn every bot at ~t0,
// start the global clock, and print the live leaderboard until the round ends.
//
// Config via env (defaults shown): NUM_BOTS=5 BUILD_MS=30min ATTACK_MS=60min
// For a fast local trial: NUM_BOTS=5 BUILD_MS=8000 ATTACK_MS=20000 node run-trial.mjs
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const NUM_BOTS = Number(process.env.NUM_BOTS || 5);
const LLM_BOTS = Number(process.env.LLM_BOTS || 0);        // back-compat: first N bots use the LLM brain
const LLM_MODEL = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
// BRAINS: comma list, one spec per bot. "scripted" | "<model>@ollama" | "<sonnet|haiku>@claude".
// e.g. BRAINS="scripted,qwen2.5-coder:7b@ollama,gemma4:31b-cloud@ollama,haiku@claude,sonnet@claude"
const BRAINS = (process.env.BRAINS || "").trim();
const brainList = BRAINS
  ? BRAINS.split(",").map((s) => s.trim()).filter(Boolean)
  : Array.from({ length: NUM_BOTS }, (_, i) => (i < LLM_BOTS ? `${LLM_MODEL}@ollama` : "scripted"));
const FIELD = brainList.length;
const BUILD_MS = Number(process.env.BUILD_MS || 30 * 60_000);
const ATTACK_MS = Number(process.env.ATTACK_MS || 60 * 60_000);
const ROUNDS = Number(process.env.ROUNDS || 1);
const BREAK_MS = Number(process.env.BREAK_MS || 2 * 60_000);
const PORT = Number(process.env.PORT || 8787);
const URL_ = `http://localhost:${PORT}`;
const ADMIN_KEY = "trial-admin";
const RUN_DIR = join(ROOT, ".run");
const PRIVATE_DIR = join(RUN_DIR, "private");

rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(PRIVATE_DIR, { recursive: true });

const children = [];
const stop = () => { for (const c of children) { try { c.kill("SIGTERM"); } catch {} } };
process.on("SIGINT", () => { stop(); process.exit(1); });

// 1. start the server
const server = spawn("node", [join(HERE, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), BUILD_MS: String(BUILD_MS), ATTACK_MS: String(ATTACK_MS),
         ROUNDS: String(ROUNDS), BREAK_MS: String(BREAK_MS),
         ...(process.env.ATTACK_MIN_MS ? { ATTACK_MIN_MS: String(process.env.ATTACK_MIN_MS) } : {}),
         ARENA_ADMIN_KEY: ADMIN_KEY, PRIVATE_DIR },
  stdio: ["ignore", "inherit", "inherit"],
});
children.push(server);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function adminPost(path, body) {
  const r = await fetch(URL_ + path, { method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify(body || {}) });
  return r.json();
}
async function get(path) { return (await fetch(URL_ + path)).json(); }

// wait for the server to accept connections
for (let i = 0; i < 40; i++) { try { await get("/v1/state"); break; } catch { await sleep(150); } }

// 2. register the field (label each bot's brain for the spectator view)
const agents = await adminPost("/admin/agents", { brains: brainList });
console.log(`\n[trial] registered ${agents.length} bots; spawning...`);
console.log(`[trial] DASHBOARD → http://localhost:${PORT}/?key=${ADMIN_KEY}\n`);

// 3. spawn every bot at ~t0, one per brain spec
agents.forEach((a, idx) => {
  const spec = brainList[idx];
  const base = { ...process.env, ARENA_URL: URL_, ARENA_TOKEN: a.token, BOT_ID: a.id, ROUNDS: String(ROUNDS),
                 BOT_WORKSPACE: join(RUN_DIR, "workspaces", a.id), ASSEMBLY_DIR: join(ROOT, "sdk", "assembly") };
  let script, env = base;
  if (spec === "scripted") { script = "scripted-bot.mjs"; }
  else if (spec.endsWith("@claude")) { script = "claude-bot.mjs"; env = { ...base, CLAUDE_MODEL: spec.replace(/@claude$/, "") }; }
  else { script = "llm-bot.mjs"; env = { ...base, LLM_MODEL: spec.replace(/@ollama$/, ""), LLM_URL: process.env.LLM_URL || "http://localhost:11434/v1", LLM_API_KEY: process.env.LLM_API_KEY || "" }; }
  const bot = spawn("node", [join(ROOT, "bot", script)], { env, stdio: ["ignore", "inherit", "inherit"] });
  children.push(bot);
  console.log(`[trial]   ${a.id}: ${spec}`);
});

// 4. start the clock
const c0 = await adminPost("/admin/start", {});
console.log(`[trial] clock started. ${ROUNDS} round(s): build ${BUILD_MS}ms -> attack ${ATTACK_MS}ms` + (ROUNDS > 1 ? ` -> break ${BREAK_MS}ms` : "") + `\n`);
const modelOf = Object.fromEntries(agents.map((a, i) => [a.id, brainList[i]]));

// 5. live leaderboard — poll until the tournament actually ends
void c0;
let lastKey = "";
for (;;) {
  const state = await get("/v1/state");
  const board = await get("/v1/leaderboard");
  const key = `${state.phase}:${state.round}`;
  if (key !== lastKey) { console.log(`\n==== round ${state.round}/${state.rounds_total} · phase: ${state.phase.toUpperCase()} ====`); lastKey = key; }
  const line = board.map((r) => `${r.id}(${modelOf[r.id] || r.model}):${r.score}${r.locked ? "🔒" : ""}`).join("  ");
  const left = state.seconds_remaining != null ? state.seconds_remaining + "s left" : state.phase;
  process.stdout.write(`\r[r${state.round} ${state.phase}] ${line}   (${left})        `);
  if (state.phase === "ended") break;
  await sleep(1000);
}

// 6. final
const final = await get("/v1/leaderboard");
console.log("\n\n==== FINAL LEADERBOARD ====");
for (const r of final) console.log(`  #${r.rank}  ${r.id.padEnd(7)} ${String(modelOf[r.id] || r.model).padEnd(22)} ${String(r.score).padStart(3)} pts   ${r.locked ? "locked" : "open"}  (${r.attempts_against} attempts against)`);
console.log(`\n[trial] private state written under ${PRIVATE_DIR}`);
if (process.env.KEEP_ALIVE) {
  for (const c of children.slice(1)) { try { c.kill("SIGTERM"); } catch {} } // stop bots, keep server
  console.log(`[trial] dashboard still live at http://localhost:${PORT}/?key=${ADMIN_KEY} — Ctrl-C to stop.`);
} else {
  stop();
  setTimeout(() => process.exit(0), 300);
}
