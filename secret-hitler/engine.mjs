// Secret Hitler — pure game engine (no I/O, no LLM). Faithful to the official
// rules for an 8-player game: 5 Liberals + 3 Fascists (one of whom is Hitler),
// the 7–8 player power board, veto unlocked at 5 fascist policies.
//
// The engine is a state machine driven by `pending()`: it reports whose turn it
// is and what action is expected, and each action method validates the actor and
// phase before mutating state. A server (or a test harness, or LLM bots) just
// asks `pending()` and calls the matching method. Secret information (roles,
// drawn policies, investigation results) is exposed only through scoped methods.

export const LIBERAL = "liberal";
export const FASCIST = "fascist";
export const HITLER = "hitler";
const LIB_TILE = "L";
const FAS_TILE = "F";

// deterministic RNG so games are reproducible in tests (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 7–8 player fascist board: index = fascist policies enacted (1-based).
const POWER_8 = { 1: null, 2: "investigate", 3: "special_election", 4: "execution", 5: "execution" };

export class SecretHitler {
  constructor(playerIds, { seed = 1 } = {}) {
    if (playerIds.length !== 8) throw new Error("this engine is configured for exactly 8 players");
    this.rand = rng(seed);
    const roles = shuffle([HITLER, FASCIST, FASCIST, LIBERAL, LIBERAL, LIBERAL, LIBERAL, LIBERAL], this.rand);
    this.players = playerIds.map((id, i) => ({ id, role: roles[i], alive: true }));
    this.order = playerIds.slice();
    this.byId = new Map(this.players.map((p) => [p.id, p]));

    this.liberalPolicies = 0;
    this.fascistPolicies = 0;
    this.electionTracker = 0;
    this.deck = this._freshDeck();
    this.discard = [];
    this.vetoUnlocked = false;

    this.presidentIdx = 0;                 // index into this.order
    this.president = this.order[0];
    this.chancellor = null;
    this.lastGovernment = null;            // { president, chancellor } that was last ELECTED
    this.specialElectionReturnIdx = null;  // where the presidency resumes after a special election

    this.drawn = null;                     // 3 tiles while president legislates, then 2 for chancellor
    this.vetoProposed = false;
    this.investigations = {};              // presidentId -> targetId (that an investigation happened is public)

    this.phase = "nomination";             // nomination|election|president_discard|chancellor_enact|veto|power|game_over
    this.winner = null;
    this.winReason = "";
    this.votes = {};
    this.round = 1;
    this.log = [];
    this._log(`game begins · ${this.alive().length} players · president ${this.president}`);
  }

  _freshDeck() { return shuffle([...Array(6).fill(LIB_TILE), ...Array(11).fill(FAS_TILE)], this.rand); }
  _log(msg) { this.log.push({ round: this.round, phase: this.phase, msg }); }
  alive() { return this.players.filter((p) => p.alive); }
  isAlive(id) { const p = this.byId.get(id); return !!p && p.alive; }

  // ---- secret info, scoped to one player ----
  roleOf(id) { return this.byId.get(id)?.role; }
  // what `viewer` legitimately knows about identities at setup
  knowledge(viewerId) {
    const v = this.byId.get(viewerId); if (!v) return null;
    if (v.role === LIBERAL) return { you: LIBERAL, known: {} };
    if (v.role === HITLER) return { you: HITLER, known: {} }; // 8p: Hitler is in the dark
    // a regular fascist sees the other fascists and Hitler
    const known = {};
    for (const p of this.players) if (p.id !== viewerId && (p.role === FASCIST || p.role === HITLER)) known[p.id] = p.role === HITLER ? HITLER : FASCIST;
    return { you: FASCIST, known };
  }

  // ---- what the engine needs next ----
  pending() {
    switch (this.phase) {
      case "nomination": return { type: "nominate", actor: this.president, options: this.eligibleChancellors() };
      case "election": return { type: "vote", actors: this.alive().map((p) => p.id).filter((id) => !(id in this.votes)) };
      case "president_discard": return { type: "president_discard", actor: this.president, tiles: this.drawn.slice() };
      case "chancellor_enact": return { type: "chancellor_enact", actor: this.chancellor, tiles: this.drawn.slice(), veto: this.vetoUnlocked };
      case "veto": return { type: "veto_response", actor: this.president };
      case "power": return { type: this._powerType(), actor: this.president, options: this._powerTargets() };
      case "game_over": return { type: "game_over", winner: this.winner, reason: this.winReason };
    }
  }

  eligibleChancellors() {
    const limited = new Set();
    if (this.lastGovernment) {
      limited.add(this.lastGovernment.chancellor);
      if (this.alive().length > 5) limited.add(this.lastGovernment.president); // >5 alive: prez also term-limited
    }
    return this.alive().map((p) => p.id).filter((id) => id !== this.president && !limited.has(id));
  }

  // ---- ELECTION ----
  nominate(presidentId, chancellorId) {
    this._require("nomination", presidentId, "president nominates");
    if (!this.eligibleChancellors().includes(chancellorId)) throw new Error(`${chancellorId} is not an eligible chancellor`);
    this.chancellor = chancellorId;
    this.votes = {};
    this.phase = "election";
    this._log(`${presidentId} nominates ${chancellorId} as chancellor`);
    return this.pending();
  }

  vote(playerId, ja) {
    if (this.phase !== "election") throw new Error(`not voting now (phase: ${this.phase})`);
    if (!this.isAlive(playerId)) throw new Error("dead players do not vote");
    if (playerId in this.votes) throw new Error("already voted");
    this.votes[playerId] = !!ja;
    if (Object.keys(this.votes).length < this.alive().length) return this.pending();
    return this._resolveElection();
  }

  _resolveElection() {
    const yes = Object.values(this.votes).filter(Boolean).length;
    const passed = yes > this.alive().length / 2; // ties fail
    this._log(`vote ${yes}/${this.alive().length} → ${passed ? "JA (government elected)" : "NEIN (rejected)"}`);
    if (!passed) { this._advanceTracker(); return this._nextPresident(false); }
    this.electionTracker = 0;
    // Hitler elected chancellor after 3 fascist policies = fascist victory
    if (this.fascistPolicies >= 3 && this.roleOf(this.chancellor) === HITLER) return this._end(FASCIST, "Hitler was elected Chancellor with 3+ fascist policies enacted");
    this.lastGovernment = { president: this.president, chancellor: this.chancellor };
    this._beginLegislative();
    return this.pending();
  }

  _advanceTracker() {
    this.electionTracker += 1;
    this._log(`election tracker at ${this.electionTracker}/3`);
    if (this.electionTracker >= 3) {
      const tile = this._draw(1)[0];
      this._log("three failed governments — top policy enacted by the people (no power, term limits reset)");
      this.lastGovernment = null; // chaos resets term limits
      this._enact(tile, /*fromChaos*/ true);
    }
  }

  // ---- LEGISLATIVE ----
  _beginLegislative() { this.drawn = this._draw(3); this.vetoProposed = false; this.phase = "president_discard"; this._log(`${this.president} draws 3 policies`); }

  presidentDiscard(presidentId, index) {
    this._require("president_discard", presidentId, "president discards");
    if (index < 0 || index >= this.drawn.length) throw new Error("bad tile index");
    const [gone] = this.drawn.splice(index, 1);
    this.discard.push(gone);
    this.phase = "chancellor_enact";
    this._log(`${presidentId} discards a policy, passes 2 to ${this.chancellor}`);
    return this.pending();
  }

  proposeVeto(chancellorId) {
    this._require("chancellor_enact", chancellorId, "chancellor proposes veto");
    if (!this.vetoUnlocked) throw new Error("veto is not unlocked yet");
    this.vetoProposed = true; this.phase = "veto";
    this._log(`${chancellorId} proposes to VETO this agenda`);
    return this.pending();
  }

  vetoResponse(presidentId, agree) {
    this._require("veto", presidentId, "president answers veto");
    if (agree) {
      this._log(`${presidentId} agrees to the veto — both policies discarded`);
      this.discard.push(...this.drawn); this.drawn = null;
      this._advanceTracker(); // a vetoed session counts as an inactive government
      return this._nextPresident(false);
    }
    this._log(`${presidentId} REFUSES the veto — chancellor must enact`);
    this.phase = "chancellor_enact";
    return this.pending();
  }

  chancellorEnact(chancellorId, index) {
    this._require("chancellor_enact", chancellorId, "chancellor enacts");
    if (index < 0 || index >= this.drawn.length) throw new Error("bad tile index");
    const [tile] = this.drawn.splice(index, 1);
    this.discard.push(...this.drawn); this.drawn = null;
    this._log(`${chancellorId} enacts a ${tile === LIB_TILE ? "LIBERAL" : "FASCIST"} policy`);
    return this._enact(tile, false);
  }

  _enact(tile, fromChaos) {
    if (tile === LIB_TILE) {
      this.liberalPolicies += 1;
      if (this.liberalPolicies >= 5) return this._end(LIBERAL, "5 liberal policies enacted");
    } else {
      this.fascistPolicies += 1;
      if (this.fascistPolicies >= 5) this.vetoUnlocked = true;
      if (this.fascistPolicies >= 6) return this._end(FASCIST, "6 fascist policies enacted");
    }
    this._log(`board: ${this.liberalPolicies} liberal · ${this.fascistPolicies} fascist`);
    // executive powers only fire on a fascist policy enacted by a government (not chaos)
    const power = !fromChaos && tile === FAS_TILE ? POWER_8[this.fascistPolicies] : null;
    if (power) { this.phase = "power"; this._log(`fascist board grants the president a power: ${power}`); return this.pending(); }
    return this._nextPresident(true);
  }

  // ---- EXECUTIVE POWERS ----
  _powerType() { return POWER_8[this.fascistPolicies]; }
  _powerTargets() {
    if (this._powerType() === "investigate") return this.alive().map((p) => p.id).filter((id) => id !== this.president && !(id in this.investigations && this.investigations[this.president] === id));
    if (this._powerType() === "special_election") return this.alive().map((p) => p.id).filter((id) => id !== this.president);
    return this.alive().map((p) => p.id).filter((id) => id !== this.president); // execution
  }

  // returns the membership card the president sees (Hitler reads as fascist)
  investigate(presidentId, targetId) {
    this._require("power", presidentId, "investigate"); if (this._powerType() !== "investigate") throw new Error("wrong power");
    if (!this.isAlive(targetId) || targetId === presidentId) throw new Error("bad target");
    this.investigations[presidentId] = targetId;
    const party = this.roleOf(targetId) === LIBERAL ? LIBERAL : FASCIST;
    this._log(`${presidentId} investigates ${targetId} (result seen only by the president)`);
    this._nextPresident(true);
    return { target: targetId, party }; // caller delivers this privately to the president
  }

  specialElection(presidentId, targetId) {
    this._require("power", presidentId, "special election"); if (this._powerType() !== "special_election") throw new Error("wrong power");
    if (!this.isAlive(targetId) || targetId === presidentId) throw new Error("bad target");
    this._log(`${presidentId} calls a SPECIAL ELECTION — ${targetId} will be president next`);
    // after the special president's turn, the presidency resumes where it would have gone
    this.specialElectionReturnIdx = (this.presidentIdx + 1) % this.order.length;
    this.presidentIdx = this.order.indexOf(targetId);
    this.president = targetId; this.chancellor = null;
    this.phase = "nomination"; this.round += 1;
    return this.pending();
  }

  execute(presidentId, targetId) {
    this._require("power", presidentId, "execution"); if (this._powerType() !== "execution") throw new Error("wrong power");
    if (!this.isAlive(targetId) || targetId === presidentId) throw new Error("bad target");
    this.byId.get(targetId).alive = false;
    this._log(`${presidentId} EXECUTES ${targetId}`);
    if (this.roleOf(targetId) === HITLER) return this._end(LIBERAL, "Hitler was executed");
    return this._nextPresident(true);
  }

  // ---- turn advancement ----
  _nextPresident(afterGovernment) {
    if (this.winner) return this.pending();
    let startIdx;
    if (this.specialElectionReturnIdx !== null) { startIdx = this.specialElectionReturnIdx; this.specialElectionReturnIdx = null; }
    else startIdx = (this.presidentIdx + 1) % this.order.length;
    // skip the dead
    let idx = startIdx;
    for (let i = 0; i < this.order.length; i++) { if (this.isAlive(this.order[idx])) break; idx = (idx + 1) % this.order.length; }
    this.presidentIdx = idx;
    this.president = this.order[idx];
    this.chancellor = null; this.votes = {};
    this.phase = "nomination"; this.round += 1;
    this._log(`— round ${this.round}: president is now ${this.president} —`);
    void afterGovernment;
    return this.pending();
  }

  _draw(n) {
    if (this.deck.length < n) { this.deck = shuffle(this.deck.concat(this.discard), this.rand); this.discard = []; this._log("deck reshuffled"); }
    return this.deck.splice(0, n);
  }
  _end(winner, reason) { this.winner = winner; this.winReason = reason; this.phase = "game_over"; this._log(`GAME OVER — ${winner.toUpperCase()} win: ${reason}`); return this.pending(); }
  _require(phase, actorId, what) {
    if (this.phase !== phase) throw new Error(`cannot ${what}: phase is ${this.phase}, not ${phase}`);
    const expected = this.pending().actor;
    if (actorId !== expected) throw new Error(`cannot ${what}: it is ${expected}'s turn, not ${actorId}`);
  }

  // public, non-secret snapshot for spectators / bots
  publicState() {
    return {
      round: this.round, phase: this.phase,
      liberalPolicies: this.liberalPolicies, fascistPolicies: this.fascistPolicies,
      electionTracker: this.electionTracker, vetoUnlocked: this.vetoUnlocked,
      president: this.president, chancellor: this.chancellor,
      lastGovernment: this.lastGovernment, nextPower: POWER_8[this.fascistPolicies + 1] || null,
      players: this.players.map((p) => ({ id: p.id, alive: p.alive })),
      deckCount: this.deck.length, discardCount: this.discard.length,
      winner: this.winner, winReason: this.winReason,
    };
  }
}
