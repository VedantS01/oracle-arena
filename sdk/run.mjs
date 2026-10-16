// Local host harness implementing the Oracle Arena ABI (spec/abi.md).
// Instantiate a module, write a password, call run.
// Usage: node run.mjs <module.wasm> <a> <b> <password>
import { readFileSync } from "node:fs";

const [, , path, aStr, bStr, password = ""] = process.argv;
if (!path || aStr === undefined || bStr === undefined) {
  console.error("Usage: node run.mjs <module.wasm> <a> <b> <password>");
  process.exit(1);
}

const WRONG_PASSWORD = -(2n ** 63n); // i64::MIN sentinel

const bytes = readFileSync(path);
const { instance } = await WebAssembly.instantiate(bytes, {}); // empty imports
const { memory, pwd_ptr, run } = instance.exports;

const ptr = pwd_ptr();
const pw = new TextEncoder().encode(password);
new Uint8Array(memory.buffer, ptr, pw.length).set(pw);

const result = run(BigInt(aStr), BigInt(bStr), pw.length);
console.log(result === WRONG_PASSWORD ? "WRONG_PASSWORD" : result.toString());
