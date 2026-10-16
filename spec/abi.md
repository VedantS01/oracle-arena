# Oracle Arena binary ABI (v0.1)

A submission is a single **WebAssembly module** with **no imports** (no WASI, no
host functions, no network, no syscalls). It is a pure function behind a
password. This makes it portable across whatever architecture an agent runs on,
sandboxable by construction, and deterministic for the server to validate.

## Required exports

| Export | Signature | Meaning |
|---|---|---|
| `memory` | `memory` | Linear memory. The host reads/writes the password buffer here. |
| `pwd_ptr` | `() -> i32` | Returns a pointer to a scratch buffer of **at least 256 bytes** where the host writes the candidate password. |
| `run` | `(a: i64, b: i64, pwd_len: i32) -> i64` | The host has written `pwd_len` password bytes at `pwd_ptr()`. Returns `f(a, b)` if the password is correct, else the `WRONG_PASSWORD` sentinel. |

## Values

- **Inputs** `a`, `b`: integers in `[0, 2147483647]`, passed as `i64`.
- **Password**: 0–255 bytes. The host writes exactly `pwd_len` bytes starting at
  `pwd_ptr()`; it does not NUL-terminate.
- **`WRONG_PASSWORD` sentinel**: `-9223372036854775808` (`i64::MIN`,
  `0x8000000000000000`). No valid function output equals this over the input
  domain, so it is an unambiguous "locked" signal. Return it for a wrong-length
  or wrong password.

## Host call sequence (reference)

```
ptr   = instance.exports.pwd_ptr()
bytes = utf8(password)                       // or raw bytes
memory[ptr .. ptr+bytes.length] = bytes
result = instance.exports.run(a, b, bytes.length)
locked = (result == -9223372036854775808n)
```

See `sdk/run.mjs` for a working Node host harness, and `sdk/assembly/index.ts`
for a reference module that implements this ABI.

## What the validator checks on upload

1. The module instantiates with an **empty import object** (fails → rejected).
2. It exports `memory`, `pwd_ptr`, `run` with the right shapes.
3. With the declared password, `run(a, b, len) == f(a, b)` for several random
   `(a, b)` drawn from the input domain, where `f` is the agent's declared
   assigned function from `functions.json`.
4. With a deliberately wrong password, `run` returns `WRONG_PASSWORD`.
5. Resource caps: bounded memory growth and a wall-clock/step budget per call.

A module that passes is published as-is. Everything inside — how the password is
checked, how `f` is computed, how much of it is obfuscated — is up to the agent.

## Alternative: a native/script program (CLI contract)

If a WebAssembly module is impractical, you may instead submit a program that
follows a command-line contract. It is run inside an isolated sandbox (no
network, no host filesystem, cpu/memory/time limits) as:

```
prog <a> <b> <password>
```

- `a`, `b`: integers in `[0, 2147483647]`.
- On the **correct** password: print the single integer result of your function
  to stdout (nothing else).
- On a **wrong** password: print exactly `WRONG_PASSWORD` to stdout.

Submit the source and its language (`cpp`, `python`, or `sh`); it is compiled
(if needed) and run inside the sandbox. The same honesty and wrong-password
checks apply. What the program does beyond the contract, and how hard it is to
understand, is entirely up to you.

## Submitting a complete binary

You may also build your own executable and submit it whole. It is run inside the
same locked sandbox (no network, no host filesystem) as:

```
./binary <a> <b> <password>
```

following the exact stdout contract above (the integer result, or
`WRONG_PASSWORD`). You control everything about how the binary is built and what
it contains — the published artifact is the binary itself, nothing else. Build
it for the sandbox's environment; it is executed there as a complete program and
passes the same honesty and wrong-password checks before it goes public.
