import { Race, STATE, ST, fmtClock, fmtHM, fmtDur, fmtPace, fmtKm, nf, crowdLabel } from "./sim.js";
import { Scene, fitLayout } from "./render.js";
import { recordVideo } from "./video.js";

const $ = (id) => document.getElementById(id);
const CATS = ["fm", "hm", "10k"];
const races = {};
const STATUS_TXT = { 0: "Finisher", 1: "Tidak finish", 2: "DNF", 3: "DQ", 4: "DNS" };

// ---------------- loading ----------------
async function load() {
  const res = await Promise.all(CATS.map((c) => fetch(`data/${c}.json`).then((r) => r.json())));
  res.forEach((d) => (races[d.id] = new Race(d)));
  $("search-btn").disabled = false;
  $("search-btn").textContent = "Cari";
  const q = new URLSearchParams(location.search).get("bib");
  if (q) {
    $("bib-input").value = q;
    search(q, true);
  }
}

// ---------------- search ----------------
function search(bib, autoplay = false) {
  const msg = $("search-msg");
  msg.className = "msg";
  msg.textContent = "";
  const key = String(bib).trim();
  if (!key) return;
  const hits = [];
  for (const c of CATS) {
    const r = races[c];
    const h = r.find(key);
    if (h) hits.push({ race: r, ...h });
  }
  const card = $("result-card");
  if (!hits.length) {
    card.classList.add("hidden");
    msg.className = "msg err";
    msg.textContent = `Bib "${key.toUpperCase()}" tidak ditemukan di FM, HM, maupun 10K.`;
    return;
  }
  const h = hits.find((x) => !x.noshow) || hits[0];
  if (h.noshow) {
    card.classList.remove("hidden");
    card.innerHTML = `
      <div class="rc-head"><div class="rc-bib">${esc(key.toUpperCase())}</div><div class="rc-cat">${esc(h.race.d.name)}</div></div>
      <p class="muted" style="margin:10px 0 0">Bib ini tidak punya catatan checkpoint (${STATUS_TXT[h.st] || "tanpa data"}), jadi tidak bisa diputar ulang.</p>`;
    return;
  }
  renderResultCard(h.race, h.i);
  if (autoplay) openReplay(h.race, h.i);
}

function renderResultCard(race, i) {
  const d = race.d;
  const st = d.st[i];
  const card = $("result-card");
  card.classList.remove("hidden");
  const fin = st === ST.FIN;
  const pill = fin ? `<span class="st-pill st-fin">FINISHER</span>` : `<span class="st-pill st-stop">${st === ST.DNF ? "DNF" : "TIDAK FINISH"}</span>`;
  const time = fin ? fmtDur(race.finishT[i]) : "–";
  const lastKm = lastRealKm(race, i);
  card.innerHTML = `
    <div class="rc-head"><div class="rc-bib">${esc(d.bib[i])}</div><div class="rc-cat">${esc(d.name)}</div></div>
    <div style="margin-top:8px">${pill}</div>
    <div class="rc-row">
      ${fin ? `<div><span class="k">Waktu</span><span class="v">${time}</span></div>` : `<div><span class="k">Checkpoint terakhir</span><span class="v">KM ${fmtKm(lastKm)}</span></div>`}
      ${fin && d.pos[i] ? `<div><span class="k">Posisi resmi</span><span class="v">#${nf.format(d.pos[i])}</span></div>` : ""}
      ${fin && d.cat[i] ? `<div><span class="k">${esc(d.cat[i])}</span><span class="v">#${nf.format(d.catPos[i])}</span></div>` : ""}
    </div>
    <button class="primary play-cta" id="play-cta">▶ Putar Replay</button>`;
  $("play-cta").onclick = () => openReplay(race, i);
}

function lastRealKm(race, i) {
  const K = race.K;
  let km = 0;
  for (let k = 0; k < K; k++) if (race.d.t[i * K + k] >= 0) km = race.km[k];
  return km;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if ($("search-btn").disabled) return;
  search($("bib-input").value);
});

// ---------------- replay ----------------
const R = {
  race: null, scene: null, sel: -1, t: 0, playing: false, speed: 120,
  W: 0, H: 0, dpr: 1, unit: 1, L: null, staticLayer: null,
  raf: 0, last: 0, lastHud: 0, events: [], bannerTimer: 0,
};

function openReplay(race, i) {
  R.race = race;
  R.sel = i;
  R.scene = new Scene(race);
  R.t = 0;
  R.events = buildEvents(race);
  history.replaceState(null, "", `?bib=${encodeURIComponent(race.d.bib[i])}`);

  $("who-bib").textContent = race.d.bib[i];
  $("who-cat").textContent = `${race.d.name} · start ${race.d.waves[0]} (wave 1)`;
  $("screen-search").classList.remove("active");
  $("screen-replay").classList.add("active");
  $("bf-badge").classList.add("hidden");
  $("banner").classList.add("hidden");
  buildMarkers();
  buildDetail();
  resize();
  setPlaying(true);
  cancelAnimationFrame(R.raf);
  R.last = performance.now();
  R.raf = requestAnimationFrame(loop);
}

function closeReplay() {
  setPlaying(false);
  cancelAnimationFrame(R.raf);
  $("screen-replay").classList.remove("active");
  $("screen-search").classList.add("active");
  history.replaceState(null, "", location.pathname);
}
$("back-btn").onclick = closeReplay;

function buildEvents(race) {
  const d = race.d, ev = [];
  for (const c of d.cops) {
    const t = c.close - d.start;
    if (t > 0 && t < race.tMax) ev.push({ t, type: "cop", text: `${c.name} · KM ${fmtKm(c.km, c.km % 1 ? 1 : 0)} ditutup ${fmtHM(c.close)}` });
  }
  if (race.bf != null) ev.push({ t: race.bf, type: "bf", n: race.activeAt(race.bf - 1) });
  return ev.sort((a, b) => a.t - b.t);
}

function showBanner(ev) {
  const b = $("banner");
  clearTimeout(R.bannerTimer);
  b.className = "banner" + (ev.type === "bf" ? " bf" : "");
  if (ev.type === "bf") {
    b.innerHTML = `BLACK FLAG · 09:45<small>Lomba dihentikan karena cuaca (WBGT ≥ 32,3°C). ±${nf.format(ev.n)} pelari masih di lintasan.</small>`;
  } else {
    b.textContent = ev.text;
  }
  R.bannerTimer = setTimeout(() => b.classList.add("hidden"), ev.type === "bf" ? 5000 : 3200);
}

function selMoments() {
  const race = R.race, i = R.sel;
  const end = race.endT[i];
  const fin = race.endState[i] === STATE.FIN;
  // time when runner passes half distance
  let half = null;
  const a = race.off[i], b = race.off[i + 1] - 1, target = race.dist / 2;
  for (let j = a; j < b; j++) {
    if (race.pKm[j] <= target && race.pKm[j + 1] >= target) {
      half = race.pT[j] + (target - race.pKm[j]) / (race.pKm[j + 1] - race.pKm[j]) * (race.pT[j + 1] - race.pT[j]);
      break;
    }
  }
  return { end, fin, half };
}

function buildMarkers() {
  const race = R.race, box = $("markers"), jumps = $("jumps");
  box.innerHTML = "";
  jumps.innerHTML = "";
  const items = [];
  const add = (t, cls, label, title) => items.push({ t, cls, label, title });
  race.d.cops.forEach((c, k) => {
    const t = c.close - race.d.start;
    if (t > 0 && t < race.tMax) add(t, "cop", `C${k + 1}`, `${c.name} ditutup ${fmtHM(c.close)}`);
  });
  if (race.bf != null) add(race.bf, "bf", "BF", "Black flag 09:45");
  const m = selMoments();
  add(m.end, "me", "◆", m.fin ? "Kamu finish" : "Kamu berhenti");
  for (const it of items) {
    const el = document.createElement("span");
    el.className = "mk " + it.cls;
    el.style.left = `${(it.t / race.tMax) * 100}%`;
    el.title = it.title;
    el.onclick = () => seek(it.t);
    box.appendChild(el);
  }
  $("mk-legend").innerHTML =
    `<span><i class="cop"></i>COP ditutup</span>` +
    (race.bf != null ? `<span><i class="bf"></i>Black flag</span>` : "") +
    `<span><i class="me"></i>${m.fin ? "Kamu finish" : "Kamu berhenti"}</span>`;

  const jb = (label, t, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => seek(t);
    jumps.appendChild(b);
  };
  jb("⟲ Awal", 0);
  if (m.half != null) jb("Separuh jarakmu", Math.max(0, m.half - 60));
  if (race.bf != null) jb("Black flag", Math.max(0, race.bf - 90));
  jb(m.fin ? "◆ Momen finish" : "◆ Momen berhenti", Math.max(0, m.end - 120), "me");
}

function buildDetail() {
  const race = R.race, i = R.sel, d = race.d;
  const fin = d.st[i] === ST.FIN;
  const rows = race.checkpointRanks(i);
  const anyEst = rows.some((r) => r && r.est);
  let html = `<div class="detail-meta">
    <div>Status<b>${fin ? "Finisher" : STATUS_TXT[d.st[i]]}</b></div>
    ${fin ? `<div>Waktu resmi<b>${fmtDur(race.finishT[i])}</b></div>` : ""}
    ${fin && d.pos[i] ? `<div>Posisi resmi<b>#${nf.format(d.pos[i])}</b></div>` : ""}
    ${fin && d.cat[i] ? `<div>${esc(d.cat[i])}<b>#${nf.format(d.catPos[i])}</b></div>` : ""}
  </div>
  <table class="cp"><thead><tr><th>KM</th><th>Jam*</th><th>Tempuh</th><th>Peringkat</th></tr></thead><tbody>`;
  for (const r of rows) {
    if (!r) continue;
    const label = r.k === race.K - 1 ? "Finish" : fmtKm(r.km, r.km % 1 ? 1 : 0);
    html += `<tr><td class="${r.est ? "est" : ""}">${label}${r.est ? "†" : ""}</td><td>${fmtClock(d.start + r.t)}</td><td>${fmtDur(r.t)}</td><td>#${nf.format(r.rank)} <span class="muted">/ ${nf.format(r.total)}</span></td></tr>`;
  }
  html += `</tbody></table>
  <p class="foot small">* Jam dihitung dari start wave 1 (${d.waves[0]}).${anyEst ? " † Checkpoint KM 5,6 tidak ada di data resmi; waktunya diestimasi." : ""}
  Peringkat checkpoint = urutan waktu tempuh di antara pelari yang tercatat melewati titik itu.</p>`;
  $("detail-body").innerHTML = html;
}

function resize() {
  if (!R.race) return;
  const wrap = $("map-wrap"), cv = $("map");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = wrap.clientWidth, h = wrap.clientHeight;
  R.dpr = dpr;
  R.W = cv.width = Math.round(w * dpr);
  R.H = cv.height = Math.round(h * dpr);
  const css = Math.min(w, h);
  R.unit = dpr * Math.min(1.35, Math.max(0.8, css / 520));
  const mobile = w < 900;
  const top = (mobile ? 46 : 58) * dpr, bottom = 26 * dpr;
  R.L = fitLayout(R.scene.geom, 0, top, R.W, R.H - top - bottom, 16 * R.unit);
  R.staticLayer = R.scene.buildStatic(R.W, R.H, R.L, R.unit);
}
window.addEventListener("resize", () => { resize(); });

function setPlaying(p) {
  R.playing = p;
  $("ic-play").classList.toggle("hidden", p);
  $("ic-pause").classList.toggle("hidden", !p);
}
$("play-btn").onclick = () => {
  if (!R.playing && R.t >= R.race.tMax) R.t = 0;
  setPlaying(!R.playing);
};
$("speeds").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  R.speed = Number(b.dataset.s);
  [...$("speeds").children].forEach((x) => x.classList.toggle("on", x === b));
});
$("scrub").addEventListener("input", (e) => {
  seek((Number(e.target.value) / 1000) * R.race.tMax, true);
});
function seek(t, fromScrub = false) {
  R.t = Math.max(0, Math.min(R.race.tMax, t));
  R.lastHud = 0;
  $("banner").classList.add("hidden");
  if (!fromScrub) $("scrub").value = String(Math.round((R.t / R.race.tMax) * 1000));
}

function loop(now) {
  const race = R.race;
  if (!race) return;
  if (R.recording) { R.last = now; R.raf = requestAnimationFrame(loop); return; }
  const dt = Math.min(0.1, (now - R.last) / 1000);
  R.last = now;
  const prevT = R.t;
  if (R.playing) {
    R.t += dt * R.speed;
    if (R.t >= race.tMax) { R.t = race.tMax; setPlaying(false); }
    for (const ev of R.events) if (prevT < ev.t && R.t >= ev.t) showBanner(ev);
  }
  race.step(R.t);
  const ctx = $("map").getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, R.W, R.H);
  R.scene.draw(ctx, R.L, R.unit, R.sel, R.t, R.staticLayer, now);

  if (now - R.lastHud > 90) {
    R.lastHud = now;
    updateHud();
  }
  R.raf = requestAnimationFrame(loop);
}

function updateHud() {
  const race = R.race, t = R.t, d = race.d;
  const s = race.stats(R.sel, t);
  $("clock").textContent = fmtClock(d.start + t);
  $("elapsed").textContent = `waktu tempuh ${fmtDur(t)}`;
  $("bf-badge").classList.toggle("hidden", !(race.bf != null && t >= race.bf));

  const chip = $("status-chip");
  const stopped = s.state === STATE.STOP;
  if (s.state === STATE.FIN) {
    chip.className = "chip fin";
    chip.textContent = `FINISH · ${fmtDur(race.finishT[R.sel])}`;
  } else if (stopped) {
    chip.className = "chip stop";
    chip.textContent = `BERHENTI · ${fmtHM(d.start + race.endT[R.sel])}`;
  } else if (s.state === STATE.EST) {
    chip.className = "chip est";
    chip.textContent = "ESTIMASI";
  } else {
    chip.className = "chip";
    chip.textContent = t <= 0 ? "SIAP START" : "BERLARI";
  }
  $("km-text").textContent = `KM ${fmtKm(s.km)} / ${fmtKm(race.dist)}`;
  $("progress-bar").style.width = `${Math.min(100, (s.km / race.dist) * 100)}%`;

  $("rank").textContent = t <= 0 ? "–" : `#${nf.format(s.rank)}`;
  $("rank-total").textContent = t <= 0 ? "" : `/ ${nf.format(s.total)}`;
  const nearShown = s.state === STATE.FIN ? null : s.near;
  $("crowd-label").textContent = nearShown == null ? "–" : (t <= 0 ? "Padat" : crowdLabel(nearShown));
  $("crowd-n").textContent = nearShown == null ? "" : `${nf.format(nearShown)} org`;
  $("ahead").textContent = t <= 0 ? "–" : nf.format(s.ahead);
  $("behind").textContent = t <= 0 ? "–" : nf.format(s.behind);
  $("pace").textContent = s.pace ? fmtPace(s.pace) : "–";
  const leader = s.finished > 0 ? race.dist : s.leaderKm;
  const gap = Math.max(0, leader - s.km);
  $("gap").textContent = s.state === STATE.FIN || t <= 0 ? "–" : (gap < 0.05 ? "Terdepan" : `${fmtKm(gap)} km`);

  let note = "";
  if (s.state === STATE.EST) note = "Setelah checkpoint terakhirnya, posisi diestimasi dari pace terakhir (maks. sampai black flag 09:45).";
  else if (stopped) note = race.bf != null && d.st[R.sel] === ST.QRY
    ? "Angka posisi & sekitar dihitung saat pelari ini berhenti (estimasi, akibat black flag/cut-off)."
    : "Angka posisi & sekitar dihitung saat pelari ini tercatat terakhir kali.";
  $("est-note").textContent = note;
  $("scrub").value = String(Math.round((t / race.tMax) * 1000));
}

// ---------------- video ----------------
let videoUrl = null;
$("share-btn").onclick = async () => {
  if (!R.race) return;
  const modal = $("video-modal");
  modal.classList.remove("hidden");
  $("vm-progress").classList.remove("hidden");
  $("vm-video").classList.add("hidden");
  $("vm-share").classList.add("hidden");
  $("vm-download").classList.add("hidden");
  $("vm-bar-fill").style.width = "0%";
  $("vm-status").textContent = "Menyiapkan…";
  const wasPlaying = R.playing;
  setPlaying(false);
  R.recording = true;
  try {
    const out = await recordVideo($("video-canvas"), R.race, R.sel, (p) => {
      $("vm-bar-fill").style.width = `${Math.round(p * 100)}%`;
      $("vm-status").textContent = `Merekam video… ${Math.round(p * 100)}%`;
    });
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(out.blob);
    const name = `bormar2026-${R.race.d.bib[R.sel]}.${out.ext}`;
    const v = $("vm-video");
    v.src = videoUrl;
    v.classList.remove("hidden");
    v.play().catch(() => {});
    $("vm-progress").classList.add("hidden");
    const dl = $("vm-download");
    dl.href = videoUrl;
    dl.download = name;
    dl.classList.remove("hidden");
    const file = new File([out.blob], name, { type: out.mime.split(";")[0] });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      const sb = $("vm-share");
      sb.classList.remove("hidden");
      sb.onclick = () => navigator.share({ files: [file], title: "Bormar 2026 Replay", text: `Replay bib ${R.race.d.bib[R.sel]} di Borobudur Marathon 2026` }).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    $("vm-status").textContent = "Maaf, browser ini belum mendukung perekaman video. Coba Chrome atau Safari terbaru.";
  }
  R.recording = false;
  R.wasPlaying = wasPlaying;
};
$("vm-close").onclick = () => {
  $("video-modal").classList.add("hidden");
  const v = $("vm-video");
  v.pause();
  if (R.wasPlaying) setPlaying(true);
};

// ---------------- PWA ----------------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

load().catch((e) => {
  console.error(e);
  $("search-btn").textContent = "Gagal memuat";
  $("search-msg").className = "msg err";
  $("search-msg").textContent = "Data gagal dimuat. Periksa koneksi lalu muat ulang halaman.";
});
