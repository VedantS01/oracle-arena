// Plumbing only: submit a complete executable YOU built (a Linux binary).
// It uploads the bytes as-is. Usage: node upload-binary.mjs <binary_path> <function_id> <password>
// Env: ARENA_URL, ARENA_TOKEN
import { readFileSync } from "node:fs";

const [, , binPath, fnStr, password] = process.argv;
if (!binPath || fnStr === undefined || password === undefined) {
  console.error("usage: node upload-binary.mjs <binary_path> <function_id> <password>");
  process.exit(2);
}
const bytes = readFileSync(binPath);
const r = await fetch(process.env.ARENA_URL + "/v1/upload", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ARENA_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ binary_base64: bytes.toString("base64"), function_id: Number(fnStr), password }),
});
console.log(JSON.stringify(await r.json()));
