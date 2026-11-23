// Canvas rendering of the route, the crowd and the selected runner.
import { STATE } from "./sim.js";

export const COLORS = {
  bg: "#0b0f1d",
  route: "rgba(214, 222, 255, 0.14)",
  routeGlow: "rgba(120, 140, 255, 0.06)",
  label: "rgba(214, 222, 255, 0.62)",
  cp: "rgba(214, 222, 255, 0.5)",
  cop: "#ff8a5c",
  run: "rgba(140, 156, 205, 0.34)",
  stop: "rgba(255, 90, 90, 0.30)",
  sel: "#ffc24b",
};

// Distinct, high-contrast colors for up to 3 compared runners.
export const RUNNER_COLORS = [
  { hex: "#ffc24b", rgb: "255,194,75" },   // gold
  { hex: "#2ee6ff", rgb: "46,230,255" },   // cyan
  { hex: "#ff4fd8", rgb: "255,79,216" },   // magenta
];

// Pre-sampled route geometry, every STEP meters, in GPX meters.
const STEP = 10;

export class RouteGeom {
  constructor(race) {
    const r = race.d.route;
    const n = r.length / 2;
    const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = r[2 * i]; ys[i] = -r[2 * i + 1]; }
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const len = cum[n - 1];
    this.len = len;
    this.mPerKm = len / race.dist;
    const m = Math.floor(len / STEP) + 1;
    this.sx = new Float32Array(m); this.sy = new Float32Array(m);
    this.nx = new Float32Array(m); this.ny = new Float32Array(m);
    let j = 0;
    for (let s = 0; s < m; s++) {
      const d = s * STEP;
      while (j < n - 2 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const f = Math.min(1, Math.max(0, (d - cum[j]) / seg));
      this.sx[s] = xs[j] + (xs[j + 1] - xs[j]) * f;
      this.sy[s] = ys[j] + (ys[j + 1] - ys[j]) * f;
      const dx = xs[j + 1] - xs[j], dy = ys[j + 1] - ys[j], L = Math.hypot(dx, dy) || 1;
      this.nx[s] = -dy / L; this.ny[s] = dx / L;
    }
    this.m = m;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
    }
    this.bbox = { minX, minY, maxX, maxY };
  }
  // sample index (float) for an official km value
  idx(km) {
    const v = (km * this.mPerKm) / STEP;
    return Math.min(this.m - 1, Math.max(0, v));
  }
  at(km, out) {
    const v = this.idx(km);
    const a = Math.floor(v), b = Math.min(this.m - 1, a + 1), f = v - a;
    out.x = this.sx[a] + (this.sx[b] - this.sx[a]) * f;
    out.y = this.sy[a] + (this.sy[b] - this.sy[a]) * f;
    out.nx = this.nx[a]; out.ny = this.ny[a];
    return out;
  }
}

// Fit the route bbox into a rectangle (device pixels).
export function fitLayout(geom, x, y, w, h, pad) {
  const b = geom.bbox;
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  const ox = x + (w - bw * s) / 2 - b.minX * s;
  const oy = y + (h - bh * s) / 2 - b.minY * s;
  return { s, ox, oy, x, y, w, h };
}

function hash01(i) {
  let x = (i + 1) * 2654435761 >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967295;
}

export class Scene {
  constructor(race) {
    this.race = race;
    this.geom = new RouteGeom(race);
    this.jit = new Float32Array(race.n);
    for (let i = 0; i < race.n; i++) {
      // triangular distribution, more runners near the centre line
      this.jit[i] = (hash01(i) + hash01(i + 99991) - 1);
    }
    this.static = null;
    this.tmp = { x: 0, y: 0, nx: 0, ny: 0 };
  }

  // Draw the route, km ticks, COPs, start/finish into an offscreen canvas.
  buildStatic(W, H, L, unit) {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
    const g = c.getContext("2d");
    const geo = this.geom, p = this.tmp;
    const P = (km) => { geo.at(km, p); return [L.ox + p.x * L.s, L.oy + p.y * L.s]; };

    g.lineJoin = "round"; g.lineCap = "round";
    const path = () => {
      g.beginPath();
      for (let s = 0; s < geo.m; s += 2) {
        const x = L.ox + geo.sx[s] * L.s, y = L.oy + geo.sy[s] * L.s;
        s === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
    };
    path(); g.strokeStyle = COLORS.routeGlow; g.lineWidth = 14 * unit; g.stroke();
    path(); g.strokeStyle = COLORS.route; g.lineWidth = 2.2 * unit; g.stroke();

    const race = this.race;
    const font = (w, px) => `${w} ${px * unit}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";

    // Timing checkpoints: thin cross line + km label
    const cps = race.km.map((k, idx) => ({ k, est: race.d.kmEst[idx] }))
      .filter((c, idx) => idx > 0 && idx < race.K - 1 && !c.est);
    g.font = font(700, 9);
    for (const c of cps) {
      const [x, y] = P(c.k);
      geo.at(c.k, p);
      const len = 7 * unit;
      g.strokeStyle = COLORS.cp; g.lineWidth = 1.2 * unit;
      g.beginPath(); g.moveTo(x - p.nx * len, y - p.ny * len); g.lineTo(x + p.nx * len, y + p.ny * len); g.stroke();
      const lx = x + p.nx * 15 * unit, ly = y + p.ny * 15 * unit;
      const txt = (c.k % 1 ? c.k.toFixed(1).replace(".", ",") : String(c.k));
      g.fillStyle = COLORS.label;
      g.fillText(txt, lx, ly);
    }
    // Cut-off points: small diamond + short label on the other side
    g.font = font(800, 8.5);
    race.d.cops.forEach((c, n) => {
      const [x, y] = P(c.km);
      geo.at(c.km, p);
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      g.fillStyle = COLORS.cop; g.fillRect(-2.6 * unit, -2.6 * unit, 5.2 * unit, 5.2 * unit);
      g.restore();
      g.fillStyle = COLORS.cop;
      g.fillText(`C${n + 1}`, x - p.nx * 14 * unit, y - p.ny * 14 * unit);
    });
    // Start / finish: ring only
    const [sx, sy] = P(0);
    g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 1.6 * unit;
    g.beginPath(); g.arc(sx, sy, 4.2 * unit, 0, Math.PI * 2); g.stroke();
    return c;
  }

  // Draw one frame. sels = [{ i, color }]. ctx is in device pixels.
  draw(ctx, L, unit, sels, t, staticLayer, now) {
    const race = this.race, geo = this.geom, p = this.tmp;
    if (staticLayer) ctx.drawImage(staticLayer, 0, 0);
    const km = race.curKm, st = race.curState;
    const spread = 3.2 * unit;
    const sz = Math.max(1.4, 1.6 * unit);
    const h = sz / 2;
    const skip = new Set(sels.map((s) => s.i));

    ctx.fillStyle = COLORS.stop;
    for (let i = 0; i < race.n; i++) {
      if (st[i] !== STATE.STOP || skip.has(i)) continue;
      geo.at(km[i], p);
      const j = this.jit[i] * spread;
      ctx.fillRect(L.ox + p.x * L.s + p.nx * j - h, L.oy + p.y * L.s + p.ny * j - h, sz, sz);
    }
    ctx.fillStyle = COLORS.run;
    for (let i = 0; i < race.n; i++) {
      const s = st[i];
      if ((s !== STATE.RUN && s !== STATE.EST) || skip.has(i)) continue;
      geo.at(km[i], p);
      const j = this.jit[i] * spread;
      ctx.fillRect(L.ox + p.x * L.s + p.nx * j - h, L.oy + p.y * L.s + p.ny * j - h, sz, sz);
    }

    const pos = [];
    // trails + glows first, so every core sits on top
    sels.forEach((sel, n) => {
      const myKm = km[sel.i];
      const rgb = sel.color.rgb;
      const k0 = Math.max(0, myKm - 1.2);
      const steps = 22;
      ctx.lineCap = "round";
      let prev = null;
      for (let s = 0; s <= steps; s++) {
        const kk = k0 + (myKm - k0) * (s / steps);
        geo.at(kk, p);
        const pt = [L.ox + p.x * L.s, L.oy + p.y * L.s];
        if (prev) {
          ctx.strokeStyle = `rgba(${rgb},${0.08 + 0.8 * (s / steps)})`;
          ctx.lineWidth = (1.2 + 3 * (s / steps)) * unit;
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(pt[0], pt[1]); ctx.stroke();
        }
        prev = pt;
      }
      geo.at(myKm, p);
      const x = L.ox + p.x * L.s, y = L.oy + p.y * L.s;
      pos.push({ x, y, n });
      const R = 34 * unit;
      const g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, `rgba(${rgb},0.75)`);
      g.addColorStop(0.3, `rgba(${rgb},0.28)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    });
    sels.forEach((sel, n) => {
      const { x, y } = pos[n];
      const rgb = sel.color.rgb;
      const stopped = st[sel.i] === STATE.STOP;
      if (!stopped) {
        const ph = (((now || 0) + n * 500) % 1500) / 1500;
        ctx.strokeStyle = `rgba(${rgb},${0.9 * (1 - ph)})`;
        ctx.lineWidth = 2 * unit;
        ctx.beginPath(); ctx.arc(x, y, (6 + 18 * ph) * unit, 0, Math.PI * 2); ctx.stroke();
      }
      // dark halo separates the dot from the crowd
      ctx.fillStyle = "rgba(11,15,29,0.9)";
      ctx.beginPath(); ctx.arc(x, y, 7 * unit, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = sel.color.hex;
      ctx.beginPath(); ctx.arc(x, y, 5.4 * unit, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = stopped ? "rgba(11,15,29,0.95)" : "#fff";
      ctx.beginPath(); ctx.arc(x, y, 2.2 * unit, 0, Math.PI * 2); ctx.fill();
    });
    // bib tags
    if (sels.length) {
      ctx.font = `800 ${10 * unit}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      sels.forEach((sel, n) => {
        const { x, y } = pos[n];
        const label = race.d.bib[sel.i];
        const w = ctx.measureText(label).width + 10 * unit, hh = 15 * unit;
        const CW = ctx.canvas.width;
        let tx = x + 10 * unit, ty = y - 20 * unit - n * 17 * unit;
        if (tx + w > CW - 2 * unit) tx = x - 10 * unit - w;
        if (ty < 2 * unit) ty = y + 12 * unit + n * 17 * unit;
        ctx.strokeStyle = `rgba(${sel.color.rgb},0.7)`; ctx.lineWidth = 1 * unit;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx < x ? tx + w : tx, ty + hh / 2); ctx.stroke();
        ctx.fillStyle = sel.color.hex;
        rr(ctx, tx, ty, w, hh, 4 * unit); ctx.fill();
        ctx.fillStyle = "#0b0f1d";
        ctx.fillText(label, tx + 5 * unit, ty + hh / 2 + 0.5 * unit);
      });
    }
    return pos;
  }
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
