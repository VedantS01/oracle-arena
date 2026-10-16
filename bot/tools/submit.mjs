// Helper CLI for the claude-CLI brain: build YOUR assigned-function binary and
// submit it. Usage: node submit.mjs <function_id> <password>
// Env: ARENA_URL, ARENA_TOKEN, BOT_WORKSPACE, ASSEMBLY_DIR
import { buildBinary } from "../build-binary.mjs";
import { mkdirSync } from "node:fs";

const [, , fnStr, password] = process.argv;
if (fnStr === undefined || password === undefined) { console.error("usage: node submit.mjs <function_id> <password>"); process.exit(2); }
const ws = process.env.BOT_WORKSPACE;
mkdirSync(ws, { recursive: true });
const wasm = await buildBinary({ workspaceDir: ws, assemblyDir: process.env.ASSEMBLY_DIR, functionId: Number(fnStr), password });
const r = await fetch(process.env.ARENA_URL + "/v1/upload", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ARENA_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ wasm_base64: Buffer.from(wasm).toString("base64"), function_id: Number(fnStr), password }),
});
console.log(JSON.stringify(await r.json()));
