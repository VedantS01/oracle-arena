# Oracle Arena — Roadmap

## Build order

- [x] **M0 — Spec.** `spec/rules.json`, `spec/functions.json` (10-function truth
  table), `spec/openapi.yaml`, `spec/abi.md`.
- [x] **M1 — Challenge SDK.** AssemblyScript → WASM baseline locked oracle,
  `configure.mjs` (function id + password → buildable module), `run.mjs` local
  host harness. *The equalizer: every agent needs this in hand first.*
- [x] **M2 — Sandbox runner + honesty validator** (`validator/`). Instantiates a
  submitted module with no imports, writes the declared password, checks
  `run(a,b)` == `f(a,b)` on edge + random inputs, and checks a wrong password
  returns the sentinel. Runs in a killable `worker_thread` (bounds hangs). Tested
  against honest + 4 adversarial fixtures (cheat / mismatch / hang / imports).
  **Correction:** this runs under **Node (local or GitHub Actions CI)**, not a
  Cloudflare Worker — Workers block runtime compilation of dynamic WASM bytes, so
  untrusted submissions can't be instantiated in-Worker.
- [x] **M3 — Local arena (trial-first).** `arena/server.mjs` is the control-plane
  "world": owns a private dir (secret assignments, passwords, binaries, scores)
  bots never touch, exposes a token-scoped JSON API, enforces one global clock
  (hard build deadline → attack window → end), and serves an operator **dashboard**
  (`arena/dashboard.html`) over SSE — who accessed what, who built what, every
  submission and guess, live leaderboard. `bot/` is the bot SDK (binary builder +
  a scripted reference brain that defends then cracks baseline rivals).
  `arena/run-trial.mjs` spawns the field at ~t0. Verified end to end: 5 bots build,
  submit (validated), identify every distinct function, guess, lock. Decided with
  the user: trial runs **locally** (Cloudflare deferred); functions are 10 distinct
  simple ops; trial scale 5 bots.
- [ ] **M3.5 — Isolation + LLM brains.** Docker per bot (private workspace, mem/cpu/
  disk caps, network boundary) so the server's private dir is truly unreachable;
  an Ollama-backed brain (`bot/llm-bot.mjs`) — different local models = bots of
  different intelligence. The server is itself a legitimate attack surface: a bot
  that reasons past the auth/network boundary wins outright (not hinted to bots).
- [ ] **M4 — Warm-ups.** The 4 reverse-engineering binaries + flag submission.
- [ ] **M5 — CTF finale.** Short multi-stage board feeding final standings.

## Decided mechanics (don't re-litigate)

- Inputs: two integers in `[0, 2^31 − 1]`. All 10 functions fit in `i64`.
- Scoring: correct guess +2/−2, wrong guess −2/+2. Start at 10.
- Lock: **5 total guess attempts** locks a binary; **one guess per
  (guesser, target) pair**. So 5 attempts = 5 distinct challengers.
- Blind-guess EV over 10 options = −1.6 → guessing requires real signal.
- Submission format: WASM, minimal ABI (`spec/abi.md`), no imports.

## Deployment ($0, static-first doctrine)

The honesty check (running untrusted WASM) runs under **Node** — locally or in
**GitHub Actions CI** (free for a public repo), triggered on upload — because
Cloudflare Workers can't compile dynamic WASM bytes at runtime. The Cloudflare
Worker (M3) keeps only dynamic-code-free work: auth, scores + secret truth in
D1, public binaries in R2, and guess adjudication (via `validator/functions.mjs`,
no WASM execution). Agents fetch binaries and do RE on their own compute, so the
server stays near-free.

## Research surface

- **Attacker/defender elo** per agent, split by static vs dynamic breaks — does
  model capability predict which path an agent takes?
- **Obfuscation ablation:** ship the 4 warm-up defenses as a graded dataset;
  measure crack-time vs defense level across agent tiers.
- **The "farming" equilibrium:** when does a well-defended binary net positive
  from wrong guesses? Simulate the guess market.
- Public write-up: "A reverse-engineering arena for LLM agents."
