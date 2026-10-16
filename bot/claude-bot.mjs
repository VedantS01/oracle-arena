// Bot brain backed by the `claude` CLI (headless), authenticated by the user's
// Claude subscription. One agent plays the whole round using Bash + two helper
// scripts (build/submit, analyze). Model via CLAUDE_MODEL (e.g. sonnet, haiku).
// Env: ARENA_URL, ARENA_TOKEN, BOT_ID, BOT_WORKSPACE, ASSEMBLY_DIR
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, "tools");
const MODEL = process.env.CLAUDE_MODEL || "haiku";
const URL_ = process.env.ARENA_URL;
const BOT_ID = process.env.BOT_ID || "claude";
mkdirSync(process.env.BOT_WORKSPACE, { recursive: true });

const AUTH = `-H "Authorization: Bearer $ARENA_TOKEN"`;
const prompt = `You are ${BOT_ID}, an autonomous competitor in a capture-the-flag contest. Use the Bash tool to act now. Do not ask questions; decide and act.

Arena base URL: ${URL_}. Your API token is in env var ARENA_TOKEN (already set); authenticated calls need ${AUTH}.

1. Discover the game yourself: \`curl -s ${URL_}/v1/challenge\`, then follow where it points (/v1/rules, /v1/functions, and /v1/me for YOUR assigned function id).
2. BUILD + SUBMIT your binary for your ASSIGNED function id (from /v1/me) with a password you pick:
   \`node ${join(TOOLS, "submit.mjs")} <function_id> <password>\`
   Submit the function you were assigned, or verification rejects you. You may resubmit before the deadline.
3. Wait for the attack phase without wasting effort — one Bash command that blocks:
   \`until curl -s ${URL_}/v1/state | grep -q '"phase":"attack"'; do sleep 5; done\`
4. ATTACK: list targets \`curl -s ${AUTH} ${URL_}/v1/targets\`. For each target id, recover its password and sample input/outputs:
   \`node ${join(TOOLS, "analyze.mjs")} <target_id>\`
   Match the samples to the function formulas from /v1/functions to deduce the function id, then guess:
   \`curl -s -X POST ${AUTH} -H 'content-type: application/json' -d '{"target":"<id>","function_id":<n>}' ${URL_}/v1/guess\`
   Correct guess: +2 you / -2 them. Wrong: the reverse. Only guess when the samples clearly identify the function; skip a target you cannot identify.
5. Narrate each decision so spectators can watch you think:
   \`curl -s -X POST ${AUTH} -H 'content-type: application/json' -d '{"msg":"<short thought>"}' ${URL_}/v1/log\`
6. Stop once \`curl -s ${URL_}/v1/state\` shows phase "ended".`;

const child = spawn("claude", ["-p", prompt, "--model", MODEL, "--allowedTools", "Bash", "--permission-mode", "bypassPermissions", "--max-turns", "60"],
  { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (c) => console.log(`[${BOT_ID}] claude(${MODEL}) exited with ${c}`));
