// Compile YOUR sources into a Linux executable using YOUR OWN build command,
// run offline inside the Linux sandbox (gcc/g++/clang/make/nasm/binutils). Your
// command must produce ./prog. Writes the resulting ELF to <out>. You control
// the build entirely; what the produced binary does and how it is made is yours.
// Usage: node compile-linux.mjs <src_dir> "<build_cmd>" <out_path>
import { runExec } from "../../sandbox/exec_runner.mjs";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , srcDir, buildCmd, outPath] = process.argv;
if (!srcDir || !buildCmd || !outPath) { console.error('usage: node compile-linux.mjs <src_dir> "<build_cmd>" <out_path>'); process.exit(2); }

const files = readdirSync(srcDir).filter((n) => statSync(join(srcDir, n)).isFile())
  .map((n) => ({ name: n, content: readFileSync(join(srcDir, n), "utf8") }));

const r = await runExec({ lang: "build", files, buildCmd, ops: [], returnBinary: true, timeoutMs: 40000 });
if (!r.ok) { console.error("build failed:", r.stage || "", r.error || r.reason || ""); process.exit(1); }
if (!r.binary_b64) { console.error("build produced no ./prog"); process.exit(1); }
writeFileSync(outPath, Buffer.from(r.binary_b64, "base64"));
console.log(JSON.stringify({ ok: true, out: outPath, bytes: Buffer.from(r.binary_b64, "base64").length }));
