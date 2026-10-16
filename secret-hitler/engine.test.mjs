// Drives the engine with random-but-legal players to prove it always reaches a
// valid terminal state and that the four win conditions all occur across games.
import { SecretHitler, LIBERAL, FASCIST, HITLER } from "./engine.mjs";

const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function playRandomGame(seed) {
  const g = new SecretHitler(PLAYERS, { seed });
  let steps = 0;
  while (g.phase !== "game_over") {
    if (steps++ > 5000) throw new Error("game did not terminate (possible infinite loop)");
    const pend = g.pending();
    switch (pend.type) {
      case "nominate": g.nominate(pend.actor, pick(pend.options)); break;
      case "vote": for (const id of pend.actors) g.vote(id, Math.random() < 0.6); break;
      case "president_discard": g.presidentDiscard(pend.actor, Math.floor(Math.random() * pend.tiles.length)); break;
      case "chancellor_enact":
        if (pend.veto && Math.random() < 0.3) g.proposeVeto(pend.actor);
        else g.chancellorEnact(pend.actor, Math.floor(Math.random() * pend.tiles.length));
        break;
      case "veto_response": g.vetoResponse(pend.actor, Math.random() < 0.5); break;
      case "investigate": g.investigate(pend.actor, pick(pend.options)); break;
      case "special_election": g.specialElection(pend.actor, pick(pend.options)); break;
      case "execution": g.execute(pend.actor, pick(pend.options)); break;
      default: throw new Error("unexpected pending type: " + pend.type);
    }
    // invariants
    const s = g.publicState();
    if (s.liberalPolicies > 5 || s.fascistPolicies > 6) throw new Error("policy count out of bounds");
    if (s.deckCount < 0) throw new Error("negative deck");
  }
  return g;
}

// 1) role setup is exactly 5 lib / 2 fascist / 1 hitler, with correct knowledge
{
  const g = new SecretHitler(PLAYERS, { seed: 42 });
  const counts = { [LIBERAL]: 0, [FASCIST]: 0, [HITLER]: 0 };
  for (const p of g.players) counts[p.role]++;
  const ok = counts[LIBERAL] === 5 && counts[FASCIST] === 2 && counts[HITLER] === 1;
  console.log(`roles: ${counts[LIBERAL]}L ${counts[FASCIST]}F 1H →`, ok ? "OK" : "WRONG");
  // a fascist knows the other fascist + hitler (2 names); hitler knows nobody; a liberal knows nobody
  const fas = g.players.find((p) => p.role === FASCIST);
  const hit = g.players.find((p) => p.role === HITLER);
  const lib = g.players.find((p) => p.role === LIBERAL);
  console.log("fascist knows", Object.keys(g.knowledge(fas.id).known).length, "others (want 2);",
    "hitler knows", Object.keys(g.knowledge(hit.id).known).length, "(want 0);",
    "liberal knows", Object.keys(g.knowledge(lib.id).known).length, "(want 0)");
}

// 2) play many games; tally outcomes and confirm all four win reasons appear
const reasons = {}; let libWins = 0, fasWins = 0;
for (let seed = 1; seed <= 400; seed++) {
  const g = playRandomGame(seed);
  if (!g.winner) throw new Error("terminated with no winner");
  if (g.winner === LIBERAL) libWins++; else fasWins++;
  reasons[g.winReason] = (reasons[g.winReason] || 0) + 1;
}
console.log(`\n400 random games all terminated. liberal wins ${libWins}, fascist wins ${fasWins}`);
console.log("win reasons seen:");
for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${r}`);

const kinds = Object.keys(reasons).join(" | ");
const allFour = /5 liberal/.test(kinds) && /6 fascist/.test(kinds) && /Hitler was elected/.test(kinds) && /Hitler was executed/.test(kinds);
console.log("\nall four win conditions exercised:", allFour ? "✅ YES" : "⚠️ not all (random may miss rare ones)");
