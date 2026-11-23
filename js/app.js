import { Race, STATE, ST, REASON, fmtClock, fmtHM, fmtDur, fmtPace, fmtKm, nf, crowdLabel, normBib } from "./sim.js";
import { Scene, fitLayout, RUNNER_COLORS } from "./render.js";
import { recordVideo } from "./video.js";

const $ = (id) => document.getElementById(id);
const CATS = ["fm", "hm", "10k"];
const MAX = 3;
const SPEEDS = [30, 60, 120, 300, 500, 750];
const races = {};
const DATA_VERSION = "3";
const STATUS_TXT = { 0: "Finisher", 1: "Tidak finish", 2: "DNF", 3: "DQ", 4: "DNS" };

// ---------------- loading ----------------
async function load() {
  const res = await Promise.all(CATS.map((c) => fetch(`data/${c}.json?v=${DATA_VERSION}`, { cache: "no-cache" }).then((r) => r.json())));
  res.forEach((d) => (races[d.id] = new Race(d)));
  $("search-btn").disabled = false;
  $("search-btn").textContent = "Cari";
  const q = new URLSearchParams(location.search).get("bib");
  if (q) {
    for (const b of q.split(",").slice(0, MAX)) addPick(b, true);
    if (P.items.length) openReplay();
  }
}

// ---------------- picking (search screen) ----------------
const P = { race: null, items: [] }; // items: runner index in P.race

function lookup(bib) {
  const key = normBib(bib);
  if (!key) return { err: "Masukkan nomor bib." };
  let noshow = null;
  for (const c of CATS) {
    const h = races[c].find(key);
    if (h && !h.noshow) return { race: races[c], i: h.i, key };
    if (h && h.noshow) noshow = { race: races[c], st: h.st };
  }
  if (noshow) return { err: `Bib ${key} (${noshow.race.d.name}) tidak punya catatan checkpoint (${STATUS_TXT[noshow.st] || "tanpa data"}), jadi tidak bisa diputar.` };
  return { err: `Bib ${key} tidak ditemukan di FM, HM, maupun 10K.` };
}

// Returns error string or null.
function tryAdd(target, bib) {
  const h = lookup(bib);
  if (h.err) return h.err;
  if (target.items.includes(h.i) && target.race === h.race) return `Bib ${h.key} sudah ada.`;
  if (target.items.length >= MAX) return `Maksimal ${MAX} bib.`;
  if (target.race && target.items.length && target.race !== h.race) {
    return `Bib ${h.key} ikut ${h.race.d.name}. Pembanding harus dari kategori yang sama (${target.race.d.name}).`;
  }
  target.race = h.race;
  target.items.push(h.i);
  return null;
}

function addPick(bib, silent = false) {
  const err = tryAdd(P, bib);
  const msg = $("search-msg");
  msg.className = err ? "msg err" : "msg";
  msg.textContent = err && !silent ? err : "";
  renderPicks();
  return !err;
}

function renderPicks() {
  const box = $("picked");
  box.innerHTML = "";
  if (!P.items.length) P.race = null;
  P.items.forEach((i, n) => {
    const race = P.race, d = race.d, col = RUNNER_COLORS[n];
    const fin = d.st[i] === ST.FIN;
    const el = document.createElement("div");
    el.className = "pick";
    el.style.setProperty("--c", col.hex);
    el.innerHTML = `<span class="dot"></span>
      <div class="main">
        <div class="bib">${esc(d.bib[i])}<span class="st-pill ${fin ? "st-fin" : "st-stop"}">${fin ? "FINISH" : (d.st[i] === ST.DNF ? "DNF" : "TIDAK FINISH")}</span></div>
        <div class="sub">${esc(d.name)} · ${fin ? `<b>${fmtDur(race.finishT[i])}</b>${d.pos[i] ? ` · #${nf.format(d.pos[i])}` : ""}` : `terakhir KM <b>${fmtKm(lastRealKm(race, i))}</b>`}</div>
      </div>
      <button class="rm" aria-label="Hapus">×</button>`;
    el.querySelector(".rm").onclick = () => { P.items.splice(n, 1); renderPicks(); };
    box.appendChild(el);
  });
  const cta = $("play-cta");
  cta.classList.toggle("hidden", !P.items.length);
  cta.textContent = P.items.length > 1 ? `▶ Putar VS (${P.items.length} pelari)` : "▶ Putar Replay";
  const inp = $("bib-input");
  inp.placeholder = P.items.length ? (P.items.length < MAX ? "+ Tambah bib pembanding" : "Maksimal 3 bib") : "Nomor bib, mis. 10404";
  inp.disabled = P.items.length >= MAX;
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
  if (addPick($("bib-input").value)) $("bib-input").value = "";
});
$("play-cta").onclick = () => openReplay();

// ---------------- replay ----------------
const R = {
  race: null, scene: null, sels: [], t: 0, playing: false, speed: 300,
  W: 0, H: 0, dpr: 1, unit: 1, L: null, staticLayer: null,
  raf: 0, last: 0, lastHud: 0, events: [], bannerTimer: 0, cards: [],
};

function openReplay() {
  R.race = P.race;
  R.scene = new Scene(R.race);
  R.events = buildEvents(R.race);
  R.t = 0;
  $("screen-search").classList.remove("active");
  $("screen-replay").classList.add("active");
  $("bf-badge").classList.add("hidden");
  $("banner").classList.add("hidden");
  $("side").classList.remove("open");
  setSpeed(R.speed);
  syncSelection();
  resize();
  setPlaying(true);
  cancelAnimationFrame(R.raf);
  R.last = performance.now();
  R.raf = requestAnimationFrame(loop);
}

// rebuild everything that depends on the selected runners
function syncSelection() {
  const race = R.race;
  R.sels = P.items.map((i, n) => ({ i, color: RUNNER_COLORS[n] }));
  history.replaceState(null, "", `?bib=${P.items.map((i) => race.d.bib[i]).join(",")}`);
  $("who-bib").innerHTML = R.sels.map((s) => `<span style="color:${s.color.hex}">${esc(race.d.bib[s.i])}</span>`).join('<span class="vs">vs</span>');
  $("who-cat").textContent = `${race.d.name} · start ${race.d.waves[0]}`;
  $("add-form").classList.toggle("hidden", R.sels.length >= MAX);
  buildCards();
  buildMarkers();
  buildDetail();
  R.lastHud = 0;
}

function closeReplay() {
  setPlaying(false);
  cancelAnimationFrame(R.raf);
  $("screen-replay").classList.remove("active");
  $("screen-search").classList.add("active");
  renderPicks();
}
$("back-btn").onclick = closeReplay;
$("info-btn").onclick = () => {
  const side = $("side");
  side.classList.toggle("open");
  $("info-btn").setAttribute("aria-expanded", side.classList.contains("open"));
  requestAnimationFrame(resize);
};

$("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = tryAdd(P, $("add-input").value);
  const msg = $("add-msg");
  msg.className = err ? "msg small err" : "msg small";
  msg.textContent = err || "";
  if (!err) { $("add-input").value = ""; syncSelection(); }
});

function removeSel(n) {
  if (P.items.length <= 1) return;
  P.items.splice(n, 1);
  syncSelection();
}

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
  if (ev.type === "bf") b.innerHTML = `BLACK FLAG · 09:45<small>Lomba dihentikan (WBGT ≥ 32,3°C). ±${nf.format(ev.n)} pelari masih di lintasan.</small>`;
  else b.textContent = ev.text;
  R.bannerTimer = setTimeout(() => b.classList.add("hidden"), ev.type === "bf" ? 4500 : 2800);
}

function momentsOf(i) {
  const race = R.race;
  return { end: race.endT[i], fin: race.endState[i] === STATE.FIN };
}

function buildMarkers() {
  const race = R.race, box = $("markers"), jumps = $("jumps");
  box.innerHTML = "";
  jumps.innerHTML = "";
  const mk = (t, cls, title, color) => {
    const el = document.createElement("span");
    el.className = "mk " + cls;
    el.style.left = `${(t / race.tMax) * 100}%`;
    if (color) el.style.setProperty("--c", color);
    el.title = title;
    el.onclick = () => seek(t);
    box.appendChild(el);
  };
  race.d.cops.forEach((c) => {
    const t = c.close - race.d.start;
    if (t > 0 && t < race.tMax) mk(t, "cop", `${c.name} ditutup ${fmtHM(c.close)}`);
  });
  if (race.bf != null) mk(race.bf, "bf", "Black flag 09:45");
  R.sels.forEach((s) => {
    const m = momentsOf(s.i);
    mk(m.end, "me", `${race.d.bib[s.i]} ${m.fin ? "finish" : "berhenti"}`, s.color.hex);
  });

  const jb = (label, t, color) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (color) { b.className = "me"; b.style.setProperty("--c", color); }
    b.onclick = () => seek(t);
    jumps.appendChild(b);
  };
  jb("⟲ Awal", 0);
  if (race.bf != null) jb("Black flag", Math.max(0, race.bf - 90));
  R.sels.forEach((s) => {
    const m = momentsOf(s.i);
    jb(`◆ ${race.d.bib[s.i]} ${m.fin ? "finish" : "berhenti"}`, Math.max(0, m.end - 120), s.color.hex);
  });
  $("mk-legend").innerHTML =
    `<span><i class="cop"></i>COP ditutup</span>` +
    (race.bf != null ? `<span><i class="bf"></i>Black flag</span>` : "") +
    `<span><i class="me"></i>Momen finish/berhenti</span>`;
}

function buildCards() {
  const race = R.race, box = $("runner-cards"), chips = $("mini-chips");
  box.innerHTML = "";
  chips.innerHTML = "";
  R.cards = R.sels.map((s, n) => {
    const el = document.createElement("div");
    el.className = "rcard";
    el.style.setProperty("--c", s.color.hex);
    el.innerHTML = `
      <div class="rc-top"><span class="dot"></span><span class="bib">${esc(race.d.bib[s.i])}</span>
        <span class="chip" data-k="chip">–</span>
        ${R.sels.length > 1 ? `<button class="rm" aria-label="Hapus">×</button>` : ""}</div>
      <div class="rc-km"><span data-k="km">KM 0</span><div class="bar"><div data-k="bar"></div></div></div>
      <div class="stat-grid">
        <div class="stat"><div class="label">Posisi</div><div class="value stack" data-k="rank">–</div></div>
        <div class="stat"><div class="label">Sekitar ±100 m</div><div class="value stack" data-k="crowd">–</div></div>
        <div class="stat"><div class="label">Pace</div><div class="value" data-k="pace">–</div></div>
        <div class="stat"><div class="label">Di depan</div><div class="value" data-k="ahead">–</div></div>
        <div class="stat"><div class="label">Di belakang</div><div class="value" data-k="behind">–</div></div>
        <div class="stat"><div class="label">Ke terdepan</div><div class="value" data-k="gap">–</div></div>
      </div>
      <div class="rc-note" data-k="note"></div>`;
    const rm = el.querySelector(".rm");
    if (rm) rm.onclick = () => removeSel(n);
    box.appendChild(el);
    const ch = document.createElement("div");
    ch.className = "mchip";
    ch.style.setProperty("--c", s.color.hex);
    ch.innerHTML = `<i></i>${R.sels.length >= 3 ? "" : `<span>${esc(race.d.bib[s.i])}</span>`}<span class="r" data-k="m">–</span>`;
    chips.appendChild(ch);
    const q = (root, k) => root.querySelector(`[data-k="${k}"]`);
    return {
      chip: q(el, "chip"), km: q(el, "km"), bar: q(el, "bar"), rank: q(el, "rank"), crowd: q(el, "crowd"),
      pace: q(el, "pace"), ahead: q(el, "ahead"), behind: q(el, "behind"), gap: q(el, "gap"), note: q(el, "note"),
      mchip: ch, m: q(ch, "m"),
    };
  });
  $("vs-box").classList.toggle("hidden", R.sels.length < 2);
}

function buildDetail() {
  const race = R.race, d = race.d;
  const per = R.sels.map((s) => race.checkpointRanks(s.i));
  const K = race.K;
  let anyEst = false;
  let html = `<table class="cp"><thead><tr><th>KM</th>${R.sels.map((s) => `<th style="--c:${s.color.hex}"><i></i>${esc(d.bib[s.i])}</th>`).join("")}</tr></thead><tbody>`;
  for (let k = 1; k < K; k++) {
    const est = d.kmEst[k];
    const cells = per.map((rows) => rows[k - 1]);
    if (cells.every((c) => !c)) continue;
    if (est) anyEst = true;
    const label = k === K - 1 ? "Finish" : fmtKm(race.km[k], race.km[k] % 1 ? 1 : 0);
    html += `<tr><td class="${est ? "est" : ""}">${label}${est ? "†" : ""}</td>` +
      cells.map((c) => c ? `<td>${fmtDur(c.t)}<small>#${nf.format(c.rank)} · ${fmtHM(d.start + c.t)}</small></td>` : `<td class="muted">–</td>`).join("") + `</tr>`;
  }
  html += `</tbody></table>
  <p class="foot small">Waktu tempuh dari start ${d.waves[0]}; baris kecil = peringkat di checkpoint · jam.${anyEst ? " † KM 5,6 tidak ada di data resmi; waktunya diestimasi." : ""}</p>`;
  $("detail-body").innerHTML = html;
}

function resize() {
  if (!R.race) return;
  const wrap = $("map-wrap"), cv = $("map");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  R.dpr = dpr;
  R.W = cv.width = Math.round(w * dpr);
  R.H = cv.height = Math.round(h * dpr);
  const css = Math.min(w, h);
  R.unit = dpr * Math.min(1.35, Math.max(0.85, css / 480));
  const mobile = w < 900;
  const top = (mobile ? 30 : 50) * dpr, bottom = 8 * dpr;
  R.L = fitLayout(R.scene.geom, 0, top, R.W, R.H - top - bottom, 14 * R.unit);
  R.staticLayer = R.scene.buildStatic(R.W, R.H, R.L, R.unit);
}
window.addEventListener("resize", () => resize());

function setPlaying(p) {
  R.playing = p;
  $("ic-play").classList.toggle("hidden", p);
  $("ic-pause").classList.toggle("hidden", !p);
}
function setSpeed(s) {
  R.speed = s;
  $("speed-btn").textContent = `${s}×`;
}
$("play-btn").onclick = () => {
  if (!R.playing && R.t >= R.race.tMax) R.t = 0;
  setPlaying(!R.playing);
};
$("speed-btn").onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(R.speed) + 1) % SPEEDS.length]);
$("scrub").addEventListener("input", (e) => seek((Number(e.target.value) / 1000) * R.race.tMax, true));
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
  R.scene.draw(ctx, R.L, R.unit, R.sels, R.t, R.staticLayer, now);
  if (now - R.lastHud > 100) { R.lastHud = now; updateHud(); }
  R.raf = requestAnimationFrame(loop);
}

function updateHud() {
  const race = R.race, t = R.t, d = race.d;
  $("clock").textContent = fmtClock(d.start + t);
  $("elapsed").textContent = fmtDur(t);
  $("bf-badge").classList.toggle("hidden", !(race.bf != null && t >= race.bf));
  $("scrub").value = String(Math.round((t / race.tMax) * 1000));
  const sheetOpen = $("side").classList.contains("open") || window.innerWidth >= 900;

  const stats = R.sels.map((s) => race.stats(s.i, t));
  stats.forEach((s, n) => {
    const c = R.cards[n], i = R.sels[n].i;
    const stopped = s.state === STATE.STOP;
    let chipCls = "chip", chipTxt = t <= 0 ? "SIAP" : "BERLARI";
    if (s.state === STATE.FIN) { chipCls = "chip fin"; chipTxt = `FINISH ${fmtDur(race.finishT[i])}`; }
    else if (stopped) {
      chipCls = "chip stop";
      const why = race.reason[i] === REASON.BF ? "BLACK FLAG" : race.reason[i] === REASON.COP ? "CUT-OFF"
        : race.reason[i] === REASON.NOFIN ? "FINISH TAK TERCATAT" : "BERHENTI";
      chipTxt = `${why} ${fmtHM(d.start + race.endT[i])}`;
    }
    else if (s.state === STATE.EST) { chipCls = "chip est"; chipTxt = "ESTIMASI"; }
    const rankTxt = t <= 0 ? "–" : `#${nf.format(s.rank)}`;
    // mini chip (always visible)
    c.mchip.className = "mchip" + (stopped ? " stop" : s.state === STATE.FIN ? " fin" : "");
    const kmTxt = R.sels.length >= 3 ? fmtKm(s.km) : `KM ${fmtKm(s.km)}`;
    c.m.textContent = t <= 0 ? "" : (s.state === STATE.FIN ? `FIN ${rankTxt}` : `${rankTxt} · ${kmTxt}`);
    if (!sheetOpen) return;
    c.chip.className = chipCls; c.chip.textContent = chipTxt;
    c.km.textContent = `KM ${fmtKm(s.km)} / ${fmtKm(race.dist)}`;
    c.bar.style.width = `${Math.min(100, (s.km / race.dist) * 100)}%`;
    c.rank.innerHTML = t <= 0 ? "–" : `${rankTxt}<small>/${nf.format(s.total)}</small>`;
    c.crowd.innerHTML = s.state === STATE.FIN ? "–" : (t <= 0 ? "Padat" : `${crowdLabel(s.near)}<small>${nf.format(s.near)} org</small>`);
    c.pace.innerHTML = s.pace ? `${fmtPace(s.pace)}<small>/km</small>` : "–";
    c.ahead.textContent = t <= 0 ? "–" : nf.format(s.ahead);
    c.behind.textContent = t <= 0 ? "–" : nf.format(s.behind);
    const leader = s.finished > 0 ? race.dist : s.leaderKm;
    const gap = Math.max(0, leader - s.km);
    c.gap.textContent = s.state === STATE.FIN || t <= 0 ? "–" : (gap < 0.05 ? "Terdepan" : `${fmtKm(gap)} km`);
    c.note.textContent = s.state === STATE.EST
      ? "Setelah checkpoint terakhir, posisi diestimasi dari pace terakhir (maks. sampai 09:45)."
      : stopped ? (race.reason[i] === REASON.COP
        ? "Diestimasi tiba di cut-off point setelah ditutup, jadi dihentikan di COP. Posisi & sekitar dihitung saat berhenti."
        : race.reason[i] === REASON.BF
          ? "Setelah catatan terakhir, posisi diestimasi dari pace terakhir sampai black flag 09:45."
          : race.reason[i] === REASON.NOFIN
            ? "Dengan pace terakhirnya pelari ini sampai di area finish sebelum 09:45, tapi waktu finish-nya tidak tercatat (status QRY)."
            : "Berhenti di catatan terakhir.") : "";
  });

  if (R.sels.length >= 2 && sheetOpen) updateVs(stats, t);
}

// Gap of each other runner relative to the first selected runner.
function updateVs(stats, t) {
  const race = R.race, d = race.d, base = R.sels[0], b = stats[0];
  let html = `<div class="vs-title">VS ${esc(d.bib[base.i])}</div>`;
  R.sels.slice(1).forEach((s, k) => {
    const o = stats[k + 1];
    let txt;
    if (t <= 0) txt = "–";
    else if (b.state === STATE.FIN && o.state === STATE.FIN) {
      const dt = race.finishT[s.i] - race.finishT[base.i];
      txt = dt === 0 ? "sama" : `${dt < 0 ? "lebih cepat" : "lebih lambat"} ${fmtDur(Math.abs(dt))}`;
    } else {
      const dk = o.km - b.km;
      if (Math.abs(dk) < 0.01) txt = "berdampingan";
      else {
        // time gap: when did the trailing runner (will) reach the leader's current km
        const leadI = dk > 0 ? s.i : base.i, trailI = dk > 0 ? base.i : s.i;
        const tl = race.timeAtKm(leadI, Math.min(o.km, b.km));
        const timeGap = tl != null ? t - tl : null;
        const trailStopped = (dk > 0 ? b : o).state === STATE.STOP;
        txt = `${dk > 0 ? "di depan" : "di belakang"} ${fmtKm(Math.abs(dk))} km` +
          (timeGap != null && !trailStopped ? ` · ±${fmtDur(timeGap)}` : "");
      }
    }
    html += `<div class="vs-row" style="--c:${s.color.hex}"><i></i><b>${esc(d.bib[s.i])}</b><span class="gap">${txt}</span></div>`;
  });
  $("vs-box").innerHTML = html;
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
  $("vm-meta").classList.add("hidden");
  $("vm-bar-fill").style.width = "0%";
  $("vm-status").textContent = "Menyiapkan…";
  const wasPlaying = R.playing;
  setPlaying(false);
  R.recording = true;
  try {
    const out = await recordVideo($("video-canvas"), R.race, R.sels, (p) => {
      $("vm-bar-fill").style.width = `${Math.round(p * 100)}%`;
      $("vm-status").textContent = `Merekam video… ${Math.round(p * 100)}%`;
    });
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(out.blob);
    const name = `bormar2026-${R.sels.map((s) => R.race.d.bib[s.i]).join("-vs-")}.${out.ext}`;
    const v = $("vm-video");
    v.src = videoUrl;
    v.classList.remove("hidden");
    v.play().catch(() => {});
    $("vm-progress").classList.add("hidden");
    v.onloadedmetadata = () => {
      const m = $("vm-meta");
      m.textContent = `Durasi ${v.duration.toFixed(1)} detik · ${(out.blob.size / 1048576).toFixed(1)} MB · ${out.method}`;
      m.classList.remove("hidden");
    };
    const dl = $("vm-download");
    dl.href = videoUrl;
    dl.download = name;
    dl.classList.remove("hidden");
    const file = new File([out.blob], name, { type: out.mime.split(";")[0] });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      const sb = $("vm-share");
      sb.classList.remove("hidden");
      sb.onclick = () => navigator.share({ files: [file], title: "Bormar 2026 Replay", text: "Replay Borobudur Marathon 2026" }).catch(() => {});
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
  $("vm-video").pause();
  if (R.wasPlaying) setPlaying(true);
};

// ---------------- PWA ----------------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // a new version took over: reload once so code and data are from the same deploy
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

load().catch((e) => {
  console.error(e);
  $("search-btn").textContent = "Gagal memuat";
  $("search-msg").className = "msg err";
  $("search-msg").textContent = "Data gagal dimuat. Periksa koneksi lalu muat ulang halaman.";
});
