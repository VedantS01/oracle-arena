// CLI wrapper around the validator.
// Usage: node cli.mjs <module.wasm> <function_id 0-9> <password>
// Exit 0 + {"ok":true}, or exit 1 + {"ok":false,"reason":...}
import { readFileSync } from "node:fs";
import { validateModule } from "./validate.mjs";

const [, , path, idStr, password = ""] = process.argv;
if (!path || idStr === undefined) {
  console.error("Usage: node cli.mjs <module.wasm> <function_id 0-9> <password>");
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(path));
const result = await validateModule(bytes, Number(idStr), password);
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
