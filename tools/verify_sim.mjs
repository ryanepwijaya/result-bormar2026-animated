// Sanity checks for the simulation against the source data.
// Usage: node tools/verify_sim.mjs
import { readFileSync } from "node:fs";
import { Race, STATE, fmtDur, fmtClock } from "../js/sim.js";

const load = (id) => new Race(JSON.parse(readFileSync(new URL(`../data/${id}.json`, import.meta.url))));
let fail = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) fail++; };

for (const id of ["fm", "hm", "10k"]) {
  const r = load(id);
  console.log(`\n== ${id}: n=${r.n} tMax=${fmtDur(r.tMax)} (until ${fmtClock(r.start + r.tMax)})`);

  // 1. Every runner hits each recorded checkpoint at the recorded time.
  let bad = 0;
  for (let i = 0; i < r.n; i++) {
    for (let k = 1; k < r.K; k++) {
      const t = r.d.t[i * r.K + k];
      if (t < 0) continue;
      const [km] = r.posOf(i, t);
      if (Math.abs(km - r.km[k]) > 0.02) bad++;
    }
  }
  check(bad === 0, `positions match recorded checkpoints (${bad} mismatches)`);

  // 2. Winner rank 1 at their finish.
  let w = 0;
  for (let i = 0; i < r.n; i++) if (r.finishT[i] < r.finishT[w]) w = i;
  r.step(r.finishT[w] + 1);
  const sw = r.stats(w, r.finishT[w] + 1);
  check(sw.rank === 1 && sw.state === STATE.FIN, `winner ${r.d.bib[w]} rank ${sw.rank} at finish ${fmtDur(r.finishT[w])}`);

  // 3. Monotonic km over time for a sample.
  let nonMono = 0;
  for (let i = 0; i < r.n; i += 37) {
    let prev = -1;
    for (let t = 0; t <= r.tMax; t += 60) {
      const [km] = r.posOf(i, t);
      if (km + 1e-6 < prev) nonMono++;
      prev = km;
    }
  }
  check(nonMono === 0, `km never decreases (${nonMono} violations)`);

  // 4. Black flag: nobody non-finisher moves after BF.
  if (r.bf != null) {
    let moving = 0, stoppedAtBf = 0;
    r.step(r.bf + 60);
    const a = Float32Array.from(r.curKm);
    r.step(r.bf + 1800);
    let lateReal = 0;
    for (let i = 0; i < r.n; i++) {
      if (r.d.st[i] === 0) continue;
      // runners whose own recorded checkpoints are after 09:45 follow their data
      if (r.lastRealT[i] > r.bf) { lateReal++; continue; }
      if (Math.abs(r.curKm[i] - a[i]) > 1e-4) moving++;
      if (Math.abs(r.endT[i] - r.bf) < 1) stoppedAtBf++;
    }
    check(moving === 0, `no non-finisher moves after black flag (${moving})`);
    console.log(`     non-finishers frozen exactly at 09:45: ${stoppedAtBf}, active at BF: ${r.activeAt(r.bf)}, with real checkpoints after 09:45: ${lateReal}`);
    const fAfter = [...r.finishT].filter((t) => t > r.bf && isFinite(t)).length;
    console.log(`     finishers who finished after 09:45 (keep running): ${fAfter}`);
  }

  // 5. Sample runner stats.
  const sample = { fm: "B10404", hm: "H20117", "10k": "P30141" }[id];
  const f = r.find(sample);
  if (f && !f.noshow) {
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const t = r.tMax * frac;
      r.step(t);
      const s = r.stats(f.i, t);
      console.log(`     ${sample} @${fmtClock(r.start + t)} km=${s.km.toFixed(2)} state=${s.state} rank=${s.rank}/${s.total} near=${s.near} ahead=${s.ahead} behind=${s.behind}`);
    }
  }
}
console.log(fail ? `\n${fail} check(s) failed` : "\nall checks passed");
process.exit(fail ? 1 : 0);
