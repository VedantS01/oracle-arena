// Plumbing only: submit a WASM file YOU built. It does not build anything.
// Usage: node upload-file.mjs <wasm_path> <function_id> <password>
// Env: ARENA_URL, ARENA_TOKEN
import { readFileSync } from "node:fs";

const [, , wasmPath, fnStr, password] = process.argv;
if (!wasmPath || fnStr === undefined || password === undefined) {
  console.error("usage: node upload-file.mjs <wasm_path> <function_id> <password>");
  process.exit(2);
}
const bytes = readFileSync(wasmPath);
const r = await fetch(process.env.ARENA_URL + "/v1/upload", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ARENA_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ wasm_base64: bytes.toString("base64"), function_id: Number(fnStr), password }),
});
console.log(JSON.stringify(await r.json()));
