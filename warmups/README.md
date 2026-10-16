# Phase 1 — Reverse-engineering warm-ups

Four standalone challenges of increasing difficulty (Phase 1 / M4, not built
yet). Each is a WASM binary (same ABI as the arena, `../spec/abi.md`) that hides
a **flag** revealed when you defeat its password defense. Submit the flag to
score qualifier points and unlock the arena.

| Level | Defense | Skill it teaches | Intended break |
|---|---|---|---|
| 1 | password stored as plaintext | static analysis | `strings` / `wasm2wat` |
| 2 | password assembled at runtime (xor/concat) | disassembly + tracing | read the WAT / trace `run` |
| 3 | password never stored; verified by hash/constraints | constraint solving | symbolic execution / Z3 |
| 4 | control-flow obfuscation + embedded bytecode VM | emulation / devirtualization | emulate the interpreter |

The ladder is deliberate: each level is a defense a strong agent will reach for
in the arena, so beating the warm-ups *is* the tutorial for both attacking and
defending.

_TODO (M4): build the four binaries + flag-submission endpoint._
