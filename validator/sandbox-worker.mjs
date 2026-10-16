// Runs inside a worker_thread so the parent can kill it on timeout.
// Instantiates an untrusted WASM submission with NO imports, checks the ABI,
// and verifies honesty against the declared function + password.
// Posts {ok, reason?} back to the parent. Never imports host functions.
import { workerData, parentPort } from "node:worker_threads";
import { fref } from "./functions.mjs";

const WRONG_PASSWORD = -(2n ** 63n); // i64::MIN sentinel (spec/abi.md)
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const DOMAIN_MAX = 2147483647n;

const { bytes, functionId, password } = workerData;

function done(ok, reason) {
  parentPort.postMessage(reason ? { ok, reason } : { ok });
}

// 1. valid wasm?
let mod;
try {
  mod = new WebAssembly.Module(bytes);
} catch (e) {
  done(false, "not valid wasm: " + e.message);
  throw 0;
}

// 2. no imports (no syscalls / host functions / network)
const imports = WebAssembly.Module.imports(mod);
if (imports.length) {
  done(false, "module declares imports: " + imports.map((i) => `${i.module}.${i.name}`).join(", "));
  throw 0;
}

// 3. instantiate with an empty import object
let ex;
try {
  ex = new WebAssembly.Instance(mod, {}).exports;
} catch (e) {
  done(false, "instantiate failed: " + e.message);
  throw 0;
}

// 4. required exports with the right shapes
if (!(ex.memory instanceof WebAssembly.Memory)) { done(false, "missing memory export"); throw 0; }
if (typeof ex.pwd_ptr !== "function") { done(false, "missing pwd_ptr export"); throw 0; }
if (typeof ex.run !== "function") { done(false, "missing run export"); throw 0; }
if (ex.memory.buffer.byteLength > MAX_MEMORY_BYTES) { done(false, "initial memory too large"); throw 0; }

function callRun(a, b, pw) {
  const ptr = Number(ex.pwd_ptr());
  const pwBytes = new TextEncoder().encode(pw);
  // re-read buffer each call in case the module grew memory
  new Uint8Array(ex.memory.buffer, ptr, pwBytes.length).set(pwBytes);
  return ex.run(a, b, pwBytes.length);
}

// 5. honesty: run(a,b,correct) == f(a,b) on edge + random inputs
const samples = [
  [0n, 0n], [0n, DOMAIN_MAX], [DOMAIN_MAX, 0n], [DOMAIN_MAX, DOMAIN_MAX], [1n, 1n],
];
for (let i = 0; i < 24; i++) {
  samples.push([randDomain(), randDomain()]);
}
for (const [a, b] of samples) {
  let got;
  try { got = callRun(a, b, password); }
  catch (e) { done(false, `run trapped on (${a},${b}): ${e.message}`); throw 0; }
  const want = fref(functionId, a, b);
  if (got !== want) {
    done(false, `output mismatch on (${a},${b}): got ${got}, declared function ${functionId} wants ${want}`);
    throw 0;
  }
}

// 6. a wrong password must return the sentinel (the lock must actually lock)
const wrongPw = password + "\x00_wrong";
let bad;
try { bad = callRun(samples[1][0], samples[1][1], wrongPw); }
catch (e) { done(false, "run trapped on wrong password: " + e.message); throw 0; }
if (bad !== WRONG_PASSWORD) {
  done(false, `wrong password not rejected: run returned ${bad}, expected sentinel ${WRONG_PASSWORD}`);
  throw 0;
}

done(true);

function randDomain() {
  // uniform-ish BigInt in [0, 2^31-1]
  return BigInt(Math.floor(Math.random() * 2147483648));
}
