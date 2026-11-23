// Client-side 9:16 replay video using canvas.captureStream + MediaRecorder.
// Supports 1–3 compared runners (same category).
import { STATE, REASON, fmtClock, fmtDur, fmtKm, nf, crowdLabel } from "./sim.js";
import { Scene, fitLayout, COLORS } from "./render.js";
import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.mjs";

const MIMES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

const INTRO = 1.2, RACE = 14, OUTRO = 3.4;
const FPS = 30;
const CREDIT = "@ryanepwijaya";
const AVC_CODECS = ["avc1.4d0028", "avc1.640028", "avc1.42e028", "avc1.42001f"];
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export async function recordVideo(canvas, race, sels, onProgress) {
  const W = canvas.width, H = canvas.height;
  const u = W / 360; // layout designed on a 360 × 640 grid
  const ctx = canvas.getContext("2d");
  const scene = new Scene(race);
  const d = race.d;
  const multi = sels.length > 1;

  // map area shrinks a little when more runner rows are needed at the bottom
  const rowsH = sels.length * 34;
  const mapTop = 108, mapBottom = 640 - 72 - rowsH;
  const L = fitLayout(scene.geom, 0, mapTop * u, W, (mapBottom - mapTop) * u, 12 * u);
  const staticLayer = scene.buildStatic(W, H, L, u * 0.95);

  const endMax = Math.max(...sels.map((s) => race.endT[s.i]));
  const tEnd = Math.min(race.tMax, endMax + Math.max(240, race.tMax * 0.04));
  const ranks = sels.map((s) => race.checkpointRanks(s.i).filter((r) => r && !r.est));
  const total = INTRO + RACE + OUTRO;
  let finalStats = null;

  // draw the frame for elapsed video time `el` (seconds)
  const render = (el, now) => {
    let t;
    if (el < INTRO) t = 0;
    else if (el < INTRO + RACE) t = easeInOut((el - INTRO) / RACE) * tEnd;
    else t = tEnd;
    race.step(t);
    const st = sels.map((s) => race.stats(s.i, t));
    if (el >= INTRO + RACE && !finalStats) finalStats = st;
    frame(t, now, st, el >= INTRO + RACE ? Math.min(1, (el - INTRO - RACE) / 0.5) : 0);
  };

  // Preferred: WebCodecs + MP4 muxer -> standard MP4 with a correct duration,
  // rendered frame by frame (no dropped frames, faster than real time).
  const codec = await pickAvcCodec(W, H);
  if (codec) return await encodeMp4(codec);
  // Fallback: MediaRecorder (real time). Some apps misread its duration.
  return await recordRealtime();

  async function encodeMp4(codec) {
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width: W, height: H, frameRate: FPS },
      fastStart: "in-memory",
    });
    let failure = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { failure = e; },
    });
    enc.configure({ codec, width: W, height: H, bitrate: 5_000_000, framerate: FPS, avc: { format: "avc" } });
    const N = Math.round(total * FPS);
    const dur = Math.round(1e6 / FPS);
    for (let i = 0; i < N; i++) {
      if (failure) throw failure;
      render(i / FPS, (i * 1000) / FPS);
      const vf = new VideoFrame(canvas, { timestamp: i * dur, duration: dur });
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      onProgress && onProgress((i + 1) / N);
      // keep the UI responsive and the encoder queue short
      if (enc.encodeQueueSize > 6 || i % 8 === 0) {
        await new Promise((r) => setTimeout(r, 0));
        while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
      }
    }
    await enc.flush();
    enc.close();
    if (failure) throw failure;
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), mime: "video/mp4", ext: "mp4" };
  }

  async function recordRealtime() {
    if (!canvas.captureStream || typeof MediaRecorder === "undefined") throw new Error("unsupported");
    const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("no mime");
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const stream = canvas.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((res) => (rec.onstop = res));
    render(0, 0);
    rec.start();
    await new Promise((resolve) => {
      let startTs = null;
      const tick = (now) => {
        if (startTs == null) startTs = now;
        const el = (now - startTs) / 1000;
        onProgress && onProgress(Math.min(1, el / total));
        render(Math.min(el, total), now);
        if (el < total) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    await done;
    return { blob: new Blob(chunks, { type: mime.split(";")[0] }), mime, ext };
  }

  function frame(t, now, st, outro) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    const cy = ((mapTop + mapBottom) / 2) * u;
    const g = ctx.createRadialGradient(W / 2, cy, 10, W / 2, cy, 280 * u);
    g.addColorStop(0, "rgba(110,130,255,0.10)");
    g.addColorStop(1, "rgba(110,130,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // header
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(214,222,255,0.6)";
    ctx.font = `700 ${9.5 * u}px ${FONT}`;
    spaced(ctx, `BOROBUDUR MARATHON 2026 · ${d.short}`, 20 * u, 38 * u, 1.5 * u);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(214,222,255,0.4)";
    ctx.font = `600 ${8 * u}px ${FONT}`;
    ctx.fillText("SIMULASI TIDAK RESMI", 340 * u, 38 * u);
    ctx.fillText(`oleh ${CREDIT}`, 340 * u, 50 * u);
    ctx.textAlign = "left";
    let x = 20 * u;
    ctx.font = `800 ${(multi ? 26 : 36) * u}px ${FONT}`;
    sels.forEach((s, n) => {
      if (n) {
        ctx.fillStyle = "rgba(214,222,255,0.5)";
        ctx.font = `700 ${12 * u}px ${FONT}`;
        ctx.fillText("vs", x + 2 * u, 78 * u);
        x += ctx.measureText("vs").width + 8 * u;
        ctx.font = `800 ${(multi ? 26 : 36) * u}px ${FONT}`;
      }
      ctx.fillStyle = s.color.hex;
      ctx.fillText(d.bib[s.i], x, 80 * u);
      x += ctx.measureText(d.bib[s.i]).width + 6 * u;
    });

    scene.draw(ctx, L, u * 0.95, sels, t, staticLayer, now);

    // clock
    const y0 = (mapBottom + 30) * u;
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${26 * u}px ${FONT}`;
    ctx.fillText(fmtClock(d.start + t), 20 * u, y0);
    ctx.font = `600 ${11 * u}px ${FONT}`;
    ctx.fillStyle = "rgba(214,222,255,0.6)";
    ctx.fillText(`+${fmtDur(t)}`, 150 * u, y0 - 1 * u);
    if (race.bf != null && t >= race.bf) {
      ctx.fillStyle = "#c81e1e";
      roundRect(ctx, W - 104 * u, y0 - 17 * u, 86 * u, 18 * u, 4 * u);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${9 * u}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText("BLACK FLAG", W - 61 * u, y0 - 4.5 * u);
      ctx.textAlign = "left";
    }

    // one row per runner
    sels.forEach((s, n) => {
      const ry = (mapBottom + 44 + n * 34) * u;
      const r = st[n];
      ctx.fillStyle = "rgba(214,222,255,0.06)";
      roundRect(ctx, 16 * u, ry, 328 * u, 29 * u, 8 * u);
      ctx.fill();
      ctx.fillStyle = s.color.hex;
      ctx.beginPath(); ctx.arc(30 * u, ry + 14.5 * u, 5 * u, 0, Math.PI * 2); ctx.fill();
      ctx.font = `800 ${13 * u}px ${FONT}`;
      ctx.fillStyle = "#fff";
      ctx.fillText(d.bib[s.i], 42 * u, ry + 19.5 * u);
      ctx.font = `700 ${12 * u}px ${FONT}`;
      const fin = r.state === STATE.FIN, stop = r.state === STATE.STOP;
      ctx.fillStyle = "rgba(214,222,255,0.85)";
      ctx.fillText(fin ? fmtDur(race.finishT[s.i]) : `KM ${fmtKm(r.km)}`, 112 * u, ry + 19.5 * u);
      ctx.fillText(t > 0 ? `#${nf.format(r.rank)}` : "–", 196 * u, ry + 19.5 * u);
      ctx.fillStyle = fin ? COLORS.sel : stop ? "#ff8f8f" : "rgba(214,222,255,0.65)";
      ctx.textAlign = "right";
      ctx.fillText(fin ? "FINISH" : stop ? "BERHENTI" : (t > 0 ? crowdLabel(r.near) : "Start"), 334 * u, ry + 19.5 * u);
      ctx.textAlign = "left";
    });

    if (outro > 0 && finalStats) drawOutro(outro);
  }

  function drawOutro(a) {
    ctx.fillStyle = `rgba(11,15,29,${0.86 * a})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = a;
    ctx.textAlign = "center";
    if (!multi) {
      const s = sels[0], r = finalStats[0], fin = race.endState[s.i] === STATE.FIN;
      ctx.fillStyle = fin ? s.color.hex : "#ff8f8f";
      ctx.font = `800 ${14 * u}px ${FONT}`;
      spacedCenter(ctx, fin ? "FINISH" : "BERHENTI", W / 2, 240 * u, 3 * u);
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${52 * u}px ${FONT}`;
      ctx.fillText(fin ? fmtDur(race.finishT[s.i]) : `KM ${fmtKm(r.km)}`, W / 2, 302 * u);
      ctx.font = `600 ${15 * u}px ${FONT}`;
      ctx.fillStyle = "rgba(214,222,255,0.8)";
      ctx.fillText(fin ? `Posisi #${nf.format(r.rank)} dari ${nf.format(r.total)}` : reasonText(race, s.i, true), W / 2, 336 * u);
      gainedLine(0, 372);
    } else {
      ctx.fillStyle = "rgba(214,222,255,0.7)";
      ctx.font = `800 ${13 * u}px ${FONT}`;
      spacedCenter(ctx, "HASIL", W / 2, 170 * u, 3 * u);
      // order: finishers by time, then non-finishers by distance
      const order = sels.map((s, n) => n).sort((x, y) => {
        const fx = race.finishT[sels[x].i], fy = race.finishT[sels[y].i];
        if (isFinite(fx) || isFinite(fy)) return fx - fy;
        return finalStats[y].km - finalStats[x].km;
      });
      order.forEach((n, k) => {
        const s = sels[n], r = finalStats[n], fin = race.endState[s.i] === STATE.FIN;
        const y = (215 + k * 82) * u;
        ctx.fillStyle = "rgba(214,222,255,0.06)";
        roundRect(ctx, 30 * u, y - 30 * u, 300 * u, 70 * u, 12 * u);
        ctx.fill();
        ctx.fillStyle = s.color.hex;
        ctx.fillRect(30 * u, y - 30 * u, 4 * u, 70 * u);
        ctx.textAlign = "left";
        ctx.font = `800 ${12 * u}px ${FONT}`;
        ctx.fillStyle = "rgba(214,222,255,0.6)";
        ctx.fillText(`${k + 1}.`, 46 * u, y - 6 * u);
        ctx.fillStyle = s.color.hex;
        ctx.font = `800 ${18 * u}px ${FONT}`;
        ctx.fillText(d.bib[s.i], 66 * u, y - 5 * u);
        ctx.fillStyle = "rgba(214,222,255,0.75)";
        ctx.font = `600 ${11.5 * u}px ${FONT}`;
        ctx.fillText(fin ? `Posisi #${nf.format(r.rank)}` : reasonText(race, s.i, false), 66 * u, y + 15 * u);
        ctx.textAlign = "right";
        ctx.fillStyle = "#fff";
        ctx.font = `800 ${24 * u}px ${FONT}`;
        ctx.fillText(fin ? fmtDur(race.finishT[s.i]) : `KM ${fmtKm(r.km)}`, 316 * u, y + 8 * u);
      });
      ctx.textAlign = "center";
    }
    ctx.font = `600 ${10 * u}px ${FONT}`;
    ctx.fillStyle = "rgba(214,222,255,0.45)";
    const fy = (multi ? 215 + sels.length * 82 : 440) * u;
    ctx.fillText(location.host || "bormar replay", W / 2, fy);
    ctx.fillText(`Simulasi tidak resmi oleh ${CREDIT} · hanya untuk hiburan`, W / 2, fy + 15 * u);
    ctx.globalAlpha = 1;
  }

  function gainedLine(n, y) {
    const rk = ranks[n];
    if (rk.length < 2) return;
    const a = rk[0], b = rk[rk.length - 1];
    const gained = a.rank - b.rank;
    ctx.font = `600 ${13 * u}px ${FONT}`;
    ctx.fillStyle = "rgba(214,222,255,0.65)";
    ctx.fillText(`KM ${fmtKm(a.km, a.km % 1 ? 1 : 0)}: #${nf.format(a.rank)}  →  ${b.k === race.K - 1 ? "Finish" : "KM " + fmtKm(b.km, b.km % 1 ? 1 : 0)}: #${nf.format(b.rank)}`, W / 2, y * u);
    if (gained > 0) {
      ctx.fillStyle = sels[n].color.hex;
      ctx.font = `800 ${16 * u}px ${FONT}`;
      ctx.fillText(`menyalip ${nf.format(gained)} pelari`, W / 2, (y + 26) * u);
    }
  }
}

async function pickAvcCodec(width, height) {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  for (const codec of AVC_CODECS) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 5_000_000, framerate: FPS, avc: { format: "avc" } });
      if (r.supported) return codec;
    } catch (e) { /* try next */ }
  }
  return null;
}

function reasonText(race, i, long) {
  const r = race.reason[i];
  if (r === REASON.BF) return long ? "Black flag 09:45" : "Black flag";
  if (r === REASON.COP) return long ? "Lewat batas cut-off" : "Cut-off";
  if (r === REASON.NOFIN) return long ? "Finish tidak tercatat" : "Finish tak tercatat";
  return "Tidak finish";
}

function easeInOut(x) {
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
