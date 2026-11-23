// Canvas rendering of the route, the crowd and the selected runner.
import { STATE } from "./sim.js";

export const COLORS = {
  bg: "#0b0f1d",
  route: "rgba(214, 222, 255, 0.16)",
  routeGlow: "rgba(120, 140, 255, 0.07)",
  label: "rgba(214, 222, 255, 0.55)",
  cop: "#ff8a5c",
  run: "rgba(200, 214, 255, 0.55)",
  est: "rgba(200, 214, 255, 0.40)",
  stop: "rgba(255, 96, 96, 0.55)",
  sel: "#ffc24b",
};

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
    g.font = `600 ${10 * unit}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    // km ticks every 5 km
    for (let k = 5; k < race.dist - 0.5; k += 5) {
      const [x, y] = P(k);
      g.fillStyle = "rgba(214,222,255,0.35)";
      g.beginPath(); g.arc(x, y, 2.2 * unit, 0, Math.PI * 2); g.fill();
      if (race.d.cops.some((c) => Math.abs(c.km - k) < 1.2)) continue;
      geo.at(k, p);
      const lx = x + p.nx * 11 * unit, ly = y + p.ny * 11 * unit;
      g.fillStyle = COLORS.label;
      g.fillText(String(k), lx, ly);
    }
    // COPs
    for (const c of race.d.cops) {
      const [x, y] = P(c.km);
      geo.at(c.km, p);
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      g.fillStyle = COLORS.cop; g.fillRect(-3.2 * unit, -3.2 * unit, 6.4 * unit, 6.4 * unit);
      g.restore();
      const lx = x - p.nx * 15 * unit, ly = y - p.ny * 15 * unit;
      g.fillStyle = COLORS.cop;
      g.fillText(c.name.replace(" ", ""), lx, ly);
    }
    // Start / finish
    const [sx, sy] = P(0);
    g.fillStyle = "#ffffff";
    g.beginPath(); g.arc(sx, sy, 4 * unit, 0, Math.PI * 2); g.fill();
    g.fillStyle = COLORS.bg;
    g.beginPath(); g.arc(sx, sy, 2 * unit, 0, Math.PI * 2); g.fill();
    g.font = `700 ${10 * unit}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.fillStyle = "rgba(255,255,255,0.8)";
    g.textAlign = "left";
    g.fillText("START / FINISH", sx + 8 * unit, sy - 9 * unit);
    return c;
  }

  // Draw one frame. ctx is in device pixels. Returns screen pos of selected.
  draw(ctx, L, unit, sel, t, staticLayer, now) {
    const race = this.race, geo = this.geom, p = this.tmp;
    if (staticLayer) ctx.drawImage(staticLayer, 0, 0);
    const km = race.curKm, st = race.curState;
    const spread = 3.2 * unit;
    const sz = Math.max(1.5, 1.7 * unit);
    const h = sz / 2;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // stopped runners
    ctx.fillStyle = COLORS.stop;
    for (let i = 0; i < race.n; i++) {
      if (st[i] !== STATE.STOP || i === sel) continue;
      geo.at(km[i], p);
      const j = this.jit[i] * spread;
      ctx.fillRect(L.ox + p.x * L.s + p.nx * j - h, L.oy + p.y * L.s + p.ny * j - h, sz, sz);
    }
    // running
    ctx.fillStyle = COLORS.run;
    for (let i = 0; i < race.n; i++) {
      const s = st[i];
      if ((s !== STATE.RUN && s !== STATE.EST) || i === sel) continue;
      geo.at(km[i], p);
      const j = this.jit[i] * spread;
      ctx.fillRect(L.ox + p.x * L.s + p.nx * j - h, L.oy + p.y * L.s + p.ny * j - h, sz, sz);
    }
    ctx.restore();

    if (sel == null || sel < 0) return null;
    // trail
    const myKm = km[sel], ms = st[sel];
    const trailKm = 0.9;
    const k0 = Math.max(0, myKm - trailKm);
    const steps = 18;
    ctx.save();
    ctx.lineCap = "round";
    let prev = null;
    for (let s = 0; s <= steps; s++) {
      const kk = k0 + (myKm - k0) * (s / steps);
      geo.at(kk, p);
      const pt = [L.ox + p.x * L.s, L.oy + p.y * L.s];
      if (prev) {
        ctx.strokeStyle = `rgba(255,194,75,${0.05 + 0.6 * (s / steps)})`;
        ctx.lineWidth = (1 + 2.5 * (s / steps)) * unit;
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(pt[0], pt[1]); ctx.stroke();
      }
      prev = pt;
    }
    geo.at(myKm, p);
    const x = L.ox + p.x * L.s, y = L.oy + p.y * L.s;
    const stopped = ms === STATE.STOP;
    const col = stopped ? "255,96,96" : "255,194,75";
    // glow
    const R = 26 * unit;
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, `rgba(${col},0.55)`);
    g.addColorStop(0.35, `rgba(${col},0.18)`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    // pulse ring
    const ph = ((now || 0) % 1600) / 1600;
    ctx.strokeStyle = `rgba(${col},${0.7 * (1 - ph)})`;
    ctx.lineWidth = 1.5 * unit;
    ctx.beginPath(); ctx.arc(x, y, (5 + 16 * ph) * unit, 0, Math.PI * 2); ctx.stroke();
    // core
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(x, y, 3.6 * unit, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgb(${col})`;
    ctx.beginPath(); ctx.arc(x, y, 2.4 * unit, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return { x, y };
  }
}
