// Client-side 9:16 replay video using canvas.captureStream + MediaRecorder.
import { STATE, ST, fmtClock, fmtDur, fmtKm, nf, crowdLabel } from "./sim.js";
import { Scene, fitLayout, COLORS } from "./render.js";

const MIMES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

const INTRO = 1.4, RACE = 14, OUTRO = 3.2;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export async function recordVideo(canvas, race, sel, onProgress) {
  if (!canvas.captureStream || typeof MediaRecorder === "undefined") throw new Error("unsupported");
  const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("no mime");
  const ext = mime.includes("mp4") ? "mp4" : "webm";

  const W = canvas.width, H = canvas.height;
  const u = W / 360; // design unit: layout drawn at 360 wide
  const ctx = canvas.getContext("2d");
  const scene = new Scene(race);
  const L = fitLayout(scene.geom, 0, 132 * u, W, 372 * u, 14 * u);
  const staticLayer = scene.buildStatic(W, H, L, u * 0.9);

  const d = race.d;
  const bib = d.bib[sel];
  const endSel = race.endT[sel];
  const tEnd = Math.min(race.tMax, endSel + Math.max(240, race.tMax * 0.04));
  const ranks = race.checkpointRanks(sel).filter((r) => r && !r.est);
  const fin = race.endState[sel] === STATE.FIN;

  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));

  const total = INTRO + RACE + OUTRO;
  let startTs = null;
  let finalStats = null;

  // draw first frame before starting the recorder
  race.step(0);
  frame(0, 0, null);
  rec.start(200);

  await new Promise((resolve) => {
    const tick = (now) => {
      if (startTs == null) startTs = now;
      const el = (now - startTs) / 1000;
      onProgress && onProgress(Math.min(1, el / total));
      let t;
      if (el < INTRO) t = 0;
      else if (el < INTRO + RACE) t = easeInOut((el - INTRO) / RACE) * tEnd;
      else t = tEnd;
      race.step(t);
      const s = race.stats(sel, t);
      if (el >= INTRO + RACE && !finalStats) finalStats = s;
      frame(t, now, s, el >= INTRO + RACE ? Math.min(1, (el - INTRO - RACE) / 0.5) : 0);
      if (el < total) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await done;
  return { blob: new Blob(chunks, { type: mime.split(";")[0] }), mime, ext };

  function frame(t, now, s, outro = 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W / 2, 318 * u, 10, W / 2, 318 * u, 300 * u);
    g.addColorStop(0, "rgba(110,130,255,0.10)");
    g.addColorStop(1, "rgba(110,130,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // header
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(214,222,255,0.6)";
    ctx.font = `700 ${10 * u}px ${FONT}`;
    spaced(ctx, "BOROBUDUR MARATHON 2026 · REPLAY", 20 * u, 44 * u, 1.6 * u);
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${40 * u}px ${FONT}`;
    ctx.fillText(bib, 20 * u, 92 * u);
    ctx.font = `600 ${13 * u}px ${FONT}`;
    ctx.fillStyle = "rgba(214,222,255,0.7)";
    ctx.fillText(`${d.name} · ${fmtKm(race.dist, race.dist % 1 ? 1 : 0)} km`, 20 * u, 116 * u);

    // map
    scene.draw(ctx, L, u * 0.9, sel, t, staticLayer, now);

    // bottom stats
    const y0 = 548 * u;
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${34 * u}px ${FONT}`;
    ctx.fillText(fmtClock(d.start + t), 20 * u, y0);
    ctx.font = `600 ${12 * u}px ${FONT}`;
    ctx.fillStyle = "rgba(214,222,255,0.6)";
    ctx.fillText(`waktu tempuh ${fmtDur(t)}`, 20 * u, y0 + 20 * u);
    if (race.bf != null && t >= race.bf) {
      ctx.fillStyle = "#c81e1e";
      roundRect(ctx, W - 138 * u, y0 - 26 * u, 118 * u, 24 * u, 5 * u);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${11 * u}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText("BLACK FLAG 09:45", W - 79 * u, y0 - 9.5 * u);
      ctx.textAlign = "left";
    }
    if (s) {
      const boxY = y0 + 22 * u;
      statBox(20, boxY, "KM", `${fmtKm(s.km)}`);
      statBox(126, boxY, "POSISI", t > 0 ? `#${nf.format(s.rank)}` : "–");
      const crowd = s.state === STATE.FIN ? "Finish" : (t > 0 ? crowdLabel(s.near) : "Padat");
      statBox(232, boxY, "SEKITAR", crowd);
    }

    // outro card
    if (outro > 0 && finalStats) {
      ctx.fillStyle = `rgba(11,15,29,${0.82 * outro})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = outro;
      ctx.textAlign = "center";
      ctx.fillStyle = fin ? COLORS.sel : "#ff8f8f";
      ctx.font = `800 ${14 * u}px ${FONT}`;
      spacedCenter(ctx, fin ? "FINISH" : "BERHENTI", W / 2, 250 * u, 3 * u);
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${52 * u}px ${FONT}`;
      ctx.fillText(fin ? fmtDur(race.finishT[sel]) : `KM ${fmtKm(finalStats.km)}`, W / 2, 312 * u);
      ctx.font = `600 ${15 * u}px ${FONT}`;
      ctx.fillStyle = "rgba(214,222,255,0.8)";
      ctx.fillText(fin ? `Posisi #${nf.format(finalStats.rank)} dari ${nf.format(finalStats.total)}` : (race.bf != null && d.st[sel] === ST.QRY ? "Black flag 09:45" : "Tidak finish"), W / 2, 346 * u);
      if (ranks.length >= 2) {
        const a = ranks[0], b = ranks[ranks.length - 1];
        const gained = a.rank - b.rank;
        ctx.font = `600 ${13 * u}px ${FONT}`;
        ctx.fillStyle = "rgba(214,222,255,0.65)";
        ctx.fillText(`KM ${fmtKm(a.km, a.km % 1 ? 1 : 0)}: #${nf.format(a.rank)}  →  ${b.k === race.K - 1 ? "Finish" : "KM " + fmtKm(b.km, b.km % 1 ? 1 : 0)}: #${nf.format(b.rank)}`, W / 2, 384 * u);
        if (gained > 0) {
          ctx.fillStyle = COLORS.sel;
          ctx.font = `800 ${16 * u}px ${FONT}`;
          ctx.fillText(`menyalip ${nf.format(gained)} pelari`, W / 2, 410 * u);
        }
      }
      ctx.font = `600 ${10 * u}px ${FONT}`;
      ctx.fillStyle = "rgba(214,222,255,0.45)";
      ctx.fillText(location.host || "bormar replay", W / 2, 470 * u);
      ctx.globalAlpha = 1;
    }
  }

  function statBox(x, y, k, v) {
    ctx.fillStyle = "rgba(214,222,255,0.06)";
    roundRect(ctx, x * u, y, 100 * u, 52 * u, 9 * u);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(214,222,255,0.6)";
    ctx.font = `700 ${9 * u}px ${FONT}`;
    spaced(ctx, k, (x + 10) * u, y + 18 * u, 1.2 * u);
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${18 * u}px ${FONT}`;
    ctx.fillText(v, (x + 10) * u, y + 41 * u);
  }
}

function easeInOut(x) {
  // gentle ease so start and the runner's finish don't feel abrupt
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function spaced(ctx, text, x, y, sp) {
  for (const ch of text) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + sp; }
}
function spacedCenter(ctx, text, cx, y, sp) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + sp;
  ctx.textAlign = "left";
  spaced(ctx, text, cx - (w - sp) / 2, y, sp);
  ctx.textAlign = "center";
}
