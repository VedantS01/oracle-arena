# Oracle Arena — honesty validator (M2)

Decides whether a submitted binary is an honest, working, locked oracle before
it goes public. Implements the checks in `../spec/abi.md`.

## Where it runs (and why not the Worker)

Cloudflare Workers **block runtime compilation of dynamic WASM bytes** (the same
restriction that disables `eval`/`new Function`), so an untrusted submission
cannot be instantiated inside a plain Worker. The validator therefore runs under
**Node** — locally, or in **GitHub Actions** (free for a public repo) triggered
on upload. The arena Worker (M3) keeps only the dynamic-code-free parts: auth,
state in D1, binaries in R2, and guess adjudication (which uses `functions.mjs`,
no WASM execution).

Execution happens in a `worker_thread` the parent can kill, so a submission that
spins forever in `run` is bounded by a timeout instead of hanging the validator.

## What it checks

1. Valid WASM that **declares no imports** (no syscalls / host calls / network).
2. Instantiates with an empty import object.
3. Exports `memory`, `pwd_ptr`, `run` with the right shapes; sane initial memory.
4. **Honest**: `run(a, b, correct_pwd) == f(a, b)` on edge + random inputs, where
   `f` is the declared function from `functions.mjs` / `spec/functions.json`.
5. **Locks**: a wrong password returns the `i64::MIN` sentinel.
6. **Terminates**: `run` returns within the time budget.

## Use

```bash
pnpm install
pnpm test                                   # builds 5 fixtures, asserts verdicts
node cli.mjs <module.wasm> <function_id> <password>   # -> {"ok":true} | {"ok":false,"reason":...}
```

`functions.mjs` is the BigInt reference for all 10 functions, shared with the
arena's guess adjudication so "what `f` computes" has exactly one definition.
