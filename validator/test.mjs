// Build the fixtures with asc, then assert the validator's verdict on each.
// Run: node test.mjs   (expects `pnpm install` to have provided assemblyscript)
import asc from "assemblyscript/asc";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateModule } from "./validate.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const build = join(dir, "build");
mkdirSync(build, { recursive: true });

async function compile(name) {
  const { error, stderr } = await asc.main([
    join(dir, "fixtures", `${name}.ts`),
    "--runtime", "stub",
    "--optimize",
    "-o", join(build, `${name}.wasm`),
  ]);
  if (error) throw new Error(`asc ${name}: ${error.message}\n${stderr.toString()}`);
  return new Uint8Array(readFileSync(join(build, `${name}.wasm`)));
}

// each case: [fixture, declaredFunctionId, declaredPassword, expectedOk, reasonMatch]
const cases = [
  ["honest",     5, "letmein", true,  null],
  ["nopassword", 5, "letmein", false, /wrong password not rejected/],
  ["wrongfn",    5, "letmein", false, /output mismatch/],
  ["hang",       5, "letmein", false, /timeout/],
  ["imports",    5, "letmein", false, /declares imports/],
];

let failed = 0;
for (const [name, id, pw, expectOk, reasonMatch] of cases) {
  const bytes = await compile(name);
  const res = await validateModule(bytes, id, pw, { timeoutMs: 800 });
  const okMatch = res.ok === expectOk;
  const reasonOk = expectOk || (res.reason && reasonMatch.test(res.reason));
  const pass = okMatch && reasonOk;
  if (!pass) failed++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name.padEnd(11)} -> ok=${res.ok}` +
    (res.reason ? `  reason="${res.reason}"` : ""),
  );
}

console.log(failed === 0 ? "\nAll validator cases passed." : `\n${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
