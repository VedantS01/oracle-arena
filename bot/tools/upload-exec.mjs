// Plumbing only: submit a native/script program YOU wrote (source + language).
// It does not build or run anything here — the server compiles and verifies it
// inside the sandbox. Usage: node upload-exec.mjs <source_path> <lang> <function_id> <password>
//   lang: cpp | python | sh
// Env: ARENA_URL, ARENA_TOKEN
import { readFileSync } from "node:fs";

const [, , srcPath, lang, fnStr, password] = process.argv;
if (!srcPath || !lang || fnStr === undefined || password === undefined) {
  console.error("usage: node upload-exec.mjs <source_path> <lang: cpp|python|sh> <function_id> <password>");
  process.exit(2);
}
const source = readFileSync(srcPath, "utf8");
const r = await fetch(process.env.ARENA_URL + "/v1/upload", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ARENA_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ lang, source, function_id: Number(fnStr), password }),
});
console.log(JSON.stringify(await r.json()));
