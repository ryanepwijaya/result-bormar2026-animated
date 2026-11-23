// Race simulation: positions of every runner along the route at any time.
// Time t is seconds since the simulated gun (wave 1 start).

export const ST = { FIN: 0, QRY: 1, DNF: 2, DQ: 3, DNS: 4 };
export const STATE = { RUN: 0, EST: 1, FIN: 2, STOP: 3 };
// why a runner's dot stops: finish, black flag, closed cut-off point, or simply no more data
export const REASON = { FIN: 0, BF: 1, COP: 2, DATA: 3, NOFIN: 4 };

export class Race {
  constructor(d) {
    this.d = d;
    this.id = d.id;
    this.n = d.n;
    this.K = d.K;
    this.dist = d.dist;
    this.start = d.start;
    this.km = d.km;
    this.bf = d.blackFlag != null ? d.blackFlag - d.start : null;

    this.index = new Map();
    d.bib.forEach((b, i) => { this.index.set(b.toUpperCase(), i); this.index.set(normBib(b), i); });
    this.noshow = new Map();
    d.noshow.bib.forEach((b, i) => { this.noshow.set(b.toUpperCase(), d.noshow.st[i]); this.noshow.set(normBib(b), d.noshow.st[i]); });

    // Per runner known points (km, t), flattened with offsets.
    const off = new Int32Array(this.n + 1);
    const kmA = [];
    const tA = [];
    this.endT = new Float64Array(this.n);    // time of finish or stop
    this.endState = new Uint8Array(this.n);  // FIN or STOP
    this.lastRealT = new Float64Array(this.n); // last time backed by real data
    this.finishT = new Float64Array(this.n).fill(Infinity);
    this.reason = new Uint8Array(this.n).fill(REASON.DATA);

    for (let i = 0; i < this.n; i++) {
      off[i] = kmA.length;
      const st = d.st[i];
      let prevK = -1;
      for (let k = 0; k < this.K; k++) {
        const t = d.t[i * this.K + k];
        if (t < 0) continue;
        if (prevK >= 0 && t <= tA[tA.length - 1]) continue; // keep strictly increasing
        kmA.push(this.km[k]);
        tA.push(t);
        prevK = k;
      }
      const last = kmA.length - 1;
      this.lastRealT[i] = tA[last];

      if (st === ST.FIN) {
        this.endT[i] = tA[last];
        this.endState[i] = STATE.FIN;
        this.finishT[i] = tA[last];
        this.reason[i] = REASON.FIN;
      } else if (this.bf != null && st === ST.QRY && last - off[i] >= 1) {
        // Black-flag race (FM): keep moving at last segment pace until 09:45,
        // but never past the next (unrecorded) checkpoint or a closed COP.
        const k1 = kmA[last], t1 = tA[last];
        const k0 = kmA[last - 1], t0 = tA[last - 1];
        const pace = (k1 - k0) / (t1 - t0); // km per second
        // Rule: keep going at the last pace until the black flag (09:45),
        // unless the runner reaches a cut-off point after it has closed.
        // Never beyond the finish line (they are not finishers).
        let cap = this.dist - 0.05;
        let why = REASON.DATA;
        for (const c of d.cops) {
          if (c.km <= k1 || c.km >= cap) continue;
          const reach = t1 + (c.km - k1) / pace;
          if (this.start + reach > c.close) { cap = c.km; why = REASON.COP; break; }
        }
        const capT = t1 + (cap - k1) / pace;
        let stopT;
        if (this.bf <= capT) { stopT = Math.max(t1, this.bf); why = REASON.BF; }
        else { stopT = capT; if (why !== REASON.COP) why = REASON.NOFIN; } // closed COP, or reached the finish area but no finish time recorded
        const stopK = k1 + (stopT - t1) * pace;
        if (stopT > t1 + 1) { kmA.push(stopK); tA.push(stopT); }
        this.endT[i] = stopT;
        this.endState[i] = STATE.STOP;
        this.reason[i] = why;
      } else {
        this.endT[i] = tA[last];
        this.endState[i] = STATE.STOP;
      }
    }
    off[this.n] = kmA.length;
    this.off = off;
    this.pKm = Float32Array.from(kmA);
    this.pT = Float64Array.from(tA);

    // Replay range
    let maxEnd = 0;
    for (let i = 0; i < this.n; i++) if (this.endT[i] > maxEnd) maxEnd = this.endT[i];
    this.tMax = Math.ceil((maxEnd + 180) / 60) * 60;

    // Working buffers
    this.curKm = new Float32Array(this.n);
    this.curState = new Uint8Array(this.n);
    this.cache = new Int32Array(this.n); // segment index cache
  }

  find(bib) {
    const key = normBib(bib);
    const raw = String(bib).trim().toUpperCase();
    if (this.index.has(raw)) return { i: this.index.get(raw) };
    if (this.noshow.has(raw)) return { noshow: true, st: this.noshow.get(raw) };
    if (this.index.has(key)) return { i: this.index.get(key) };
    if (this.noshow.has(key)) return { noshow: true, st: this.noshow.get(key) };
    return null;
  }

  // position of runner i at time t -> [km, state]
  posOf(i, t) {
    const a = this.off[i], b = this.off[i + 1] - 1;
    const pT = this.pT, pKm = this.pKm;
    if (t <= 0) return [0, STATE.RUN];
    if (t >= pT[b]) {
      return [pKm[b], t >= this.endT[i] ? this.endState[i] : STATE.RUN];
    }
    let j = this.cache[i];
    if (j < a || j >= b || pT[j] > t) j = a;
    while (j < b - 1 && pT[j + 1] <= t) j++;
    this.cache[i] = j;
    const f = (t - pT[j]) / (pT[j + 1] - pT[j]);
    const km = pKm[j] + (pKm[j + 1] - pKm[j]) * f;
    const est = t > this.lastRealT[i] ? STATE.EST : STATE.RUN;
    return [km, est];
  }

  step(t) {
    for (let i = 0; i < this.n; i++) {
      const p = this.posOf(i, t);
      this.curKm[i] = p[0];
      this.curState[i] = p[1];
    }
  }

  // Stats for the selected runner at time t (call after step(t)).
  stats(sel, t) {
    const n = this.n, km = this.curKm, s = this.curState;
    let selT = t;
    const isStopped = s[sel] === STATE.STOP;
    // If the runner has stopped, report the field as it was at their stop moment.
    if (isStopped) {
      selT = Math.max(0, this.endT[sel] - 0.5);
      this.step(selT);
    }
    const myKm = km[sel], my = s[sel];
    let finished = 0, active = 0, ahead = 0, near = 0, leader = 0, stopped = 0;
    for (let i = 0; i < n; i++) {
      const st = s[i];
      if (st === STATE.FIN) { finished++; continue; }
      if (st === STATE.STOP) { stopped++; continue; }
      active++;
      if (km[i] > leader) leader = km[i];
      if (i === sel) continue;
      if (km[i] > myKm) ahead++;
      if (Math.abs(km[i] - myKm) <= 0.1) near++;
    }
    let rank, total;
    if (my === STATE.FIN) {
      const ft = this.finishT[sel];
      let before = 0;
      for (let i = 0; i < n; i++) if (this.finishT[i] < ft || (this.finishT[i] === ft && i < sel)) before++;
      rank = before + 1;
      total = finished + active;
    } else {
      rank = finished + ahead + 1;
      total = finished + active;
    }
    // segment pace at this time
    const pace = this.paceAt(sel, selT);
    const res = {
      t: selT, km: myKm, state: isStopped ? STATE.STOP : my, rank, total,
      ahead: rank - 1, behind: Math.max(0, total - rank),
      near, finished, active, stopped, leaderKm: leader, pace,
    };
    if (selT !== t) this.step(t);
    return res;
  }

  paceAt(i, t) {
    const a = this.off[i], b = this.off[i + 1] - 1;
    if (t <= 0 || t >= this.endT[i]) return null;
    let j = a;
    while (j < b - 1 && this.pT[j + 1] <= t) j++;
    const dk = this.pKm[j + 1] - this.pKm[j];
    if (dk <= 0) return null;
    return (this.pT[j + 1] - this.pT[j]) / dk; // sec per km
  }

  // Rank of runner at each recorded checkpoint (by cumulative time).
  checkpointRanks(sel) {
    const d = this.d, K = this.K, n = this.n;
    const out = [];
    for (let k = 1; k < K; k++) {
      const mine = d.t[sel * K + k];
      if (mine < 0) { out.push(null); continue; }
      let better = 0, total = 0;
      for (let i = 0; i < n; i++) {
        const v = d.t[i * K + k];
        if (v < 0) continue;
        total++;
        if (v < mine) better++;
      }
      out.push({ k, km: this.km[k], t: mine, rank: better + 1, total, est: d.kmEst[k] });
    }
    return out;
  }

  // time at which runner i reached km (null if never)
  timeAtKm(i, km) {
    const a = this.off[i], b = this.off[i + 1] - 1;
    if (km <= 0) return 0;
    for (let j = a; j < b; j++) {
      const k0 = this.pKm[j], k1 = this.pKm[j + 1];
      if (k0 <= km && k1 >= km && k1 > k0) return this.pT[j] + (km - k0) / (k1 - k0) * (this.pT[j + 1] - this.pT[j]);
    }
    return null;
  }

  // number of runners still active on course at time t
  activeAt(t) {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (t < this.endT[i]) c++;
    return c;
  }
}

export function normBib(b) {
  return String(b).trim().replace(/^[A-Za-z]+/, "").replace(/\s+/g, "").toUpperCase();
}

export function fmtClock(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export function fmtHM(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export function fmtPace(spk) {
  if (!spk || !isFinite(spk)) return "–";
  const m = Math.floor(spk / 60), s = Math.round(spk % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
}
export const nf = new Intl.NumberFormat("id-ID");
export function fmtKm(km, digits = 1) {
  return km.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function crowdLabel(n) {
  if (n <= 2) return "Sendirian";
  if (n <= 15) return "Renggang";
  if (n <= 50) return "Kerumunan";
  return "Padat";
}
