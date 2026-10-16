// Build a password-locked WASM in the bot's OWN workspace (no shared files, so
// many bots can build concurrently). Copies the SDK's AssemblyScript template,
// writes a per-bot config, and compiles. This is the sanctioned toolchain a
// baseline bot uses; a smarter bot is free to produce its binary any other way.
import asc from "assemblyscript/asc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export async function buildBinary({ workspaceDir, assemblyDir, functionId, password }) {
  const asmOut = join(workspaceDir, "assembly");
  mkdirSync(asmOut, { recursive: true });

  // template modules, copied verbatim
  for (const f of ["index.ts", "functions.ts"]) {
    writeFileSync(join(asmOut, f), readFileSync(join(assemblyDir, f)));
  }
  // per-bot config: which function, and the expected password bytes
  const bytes = [...new TextEncoder().encode(password)];
  const hex = bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(",");
  writeFileSync(join(asmOut, "config.ts"),
    `export const FUNCTION_ID: i32 = ${functionId};\n` +
    `export const EXPECTED: usize = memory.data<u8>([${hex}]);\n` +
    `export const EXPECTED_LEN: i32 = ${bytes.length};\n`);

  const out = join(workspaceDir, "oracle.wasm");
  const { error, stderr } = await asc.main(
    [join(asmOut, "index.ts"), "--runtime", "stub", "--optimize", "-o", out],
  );
  if (error) throw new Error("asc failed: " + error.message + "\n" + stderr.toString());
  return readFileSync(out);
}
