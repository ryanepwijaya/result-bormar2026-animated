// Remux a fragmented MP4 (as produced by MediaRecorder) into a standard,
// fast-start MP4 with correct duration metadata. Video track only (H.264).
// Some players and social apps read the header duration of fragmented files
// as ~0 and cut the video short; a plain MP4 avoids that.
import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.mjs";

function boxes(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, end: p + size, body: p + hdr });
    p += size;
  }
  return out;
}
const find = (u8, list, type) => list.find((b) => b.type === type);
const kids = (u8, box, skip = 0) => boxes(u8, box.body + skip, box.end);

export function isFragmentedMp4(u8) {
  return boxes(u8, 0, u8.length).some((b) => b.type === "moof");
}

export function remuxFragmentedMp4(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const top = boxes(u8, 0, u8.length);
  const moov = find(u8, top, "moov");
  if (!moov) throw new Error("no moov");
  const moovKids = kids(u8, moov);

  // find the video track
  let track = null;
  for (const trak of moovKids.filter((b) => b.type === "trak")) {
    const tk = kids(u8, trak);
    const tkhd = find(u8, tk, "tkhd");
    const mdia = find(u8, tk, "mdia");
    const mk = kids(u8, mdia);
    const hdlr = find(u8, mk, "hdlr");
    const handler = String.fromCharCode(...u8.subarray(hdlr.body + 8, hdlr.body + 12));
    if (handler !== "vide") continue;
    const mdhd = find(u8, mk, "mdhd");
    const v = u8[mdhd.body];
    const timescale = v === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
    const tkv = u8[tkhd.body];
    const trackId = tkv === 1 ? dv.getUint32(tkhd.body + 20) : dv.getUint32(tkhd.body + 12);
    const minf = find(u8, mk, "minf");
    const stbl = find(u8, kids(u8, minf), "stbl");
    const stsd = find(u8, kids(u8, stbl), "stsd");
    const entries = kids(u8, stsd, 8);
    const avc1 = entries.find((e) => e.type === "avc1" || e.type === "avc3");
    if (!avc1) throw new Error("not H.264");
    const width = dv.getUint16(avc1.body + 24), height = dv.getUint16(avc1.body + 26);
    const avcC = boxes(u8, avc1.body + 78, avc1.end).find((b) => b.type === "avcC");
    const description = u8.slice(avcC.body, avcC.end);
    const hex = (n) => n.toString(16).padStart(2, "0");
    const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
    track = { trackId, timescale, width, height, description, codec };
    break;
  }
  if (!track) throw new Error("no video track");

  // trex defaults
  let defDur = 0, defSize = 0, defFlags = 0;
  const mvex = find(u8, moovKids, "mvex");
  if (mvex) {
    for (const trex of kids(u8, mvex).filter((b) => b.type === "trex")) {
      if (dv.getUint32(trex.body + 4) !== track.trackId) continue;
      defDur = dv.getUint32(trex.body + 12);
      defSize = dv.getUint32(trex.body + 16);
      defFlags = dv.getUint32(trex.body + 20);
    }
  }

  // collect samples from every moof/traf/trun
  const samples = [];
  let nextDts = 0;
  for (const moof of top.filter((b) => b.type === "moof")) {
    for (const traf of kids(u8, moof).filter((b) => b.type === "traf")) {
      const tk = kids(u8, traf);
      const tfhd = find(u8, tk, "tfhd");
      const tfFlags = dv.getUint32(tfhd.body) & 0xffffff;
      if (dv.getUint32(tfhd.body + 4) !== track.trackId) continue;
      let q = tfhd.body + 8;
      let base = moof.start;
      if (tfFlags & 0x1) { base = Number(dv.getBigUint64(q)); q += 8; }
      if (tfFlags & 0x2) q += 4;
      let tDur = defDur, tSize = defSize, tFlags = defFlags;
      if (tfFlags & 0x8) { tDur = dv.getUint32(q); q += 4; }
      if (tfFlags & 0x10) { tSize = dv.getUint32(q); q += 4; }
      if (tfFlags & 0x20) { tFlags = dv.getUint32(q); q += 4; }
      const tfdt = find(u8, tk, "tfdt");
      if (tfdt) {
        nextDts = u8[tfdt.body] === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
      }
      let dataPtr = base;
      for (const trun of tk.filter((b) => b.type === "trun")) {
        const ver = u8[trun.body];
        const fl = dv.getUint32(trun.body) & 0xffffff;
        const count = dv.getUint32(trun.body + 4);
        let r = trun.body + 8;
        if (fl & 0x1) { dataPtr = base + dv.getInt32(r); r += 4; }
        let firstFlags = null;
        if (fl & 0x4) { firstFlags = dv.getUint32(r); r += 4; }
        for (let n = 0; n < count; n++) {
          let dur = tDur, size = tSize, flags = n === 0 && firstFlags != null ? firstFlags : tFlags, cto = 0;
          if (fl & 0x100) { dur = dv.getUint32(r); r += 4; }
          if (fl & 0x200) { size = dv.getUint32(r); r += 4; }
          if (fl & 0x400) { flags = dv.getUint32(r); r += 4; }
          if (fl & 0x800) { cto = ver === 0 ? dv.getUint32(r) : dv.getInt32(r); r += 4; }
          samples.push({ off: dataPtr, size, dts: nextDts, dur, cto, key: !(flags & 0x10000) });
          dataPtr += size;
          nextDts += dur;
        }
      }
    }
  }
  if (!samples.length) throw new Error("no samples");

  // fill missing durations from the next sample's timestamp
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].dur) samples[i].dur = i + 1 < samples.length ? samples[i + 1].dts - samples[i].dts : (samples[i - 1]?.dur || track.timescale / 30);
  }

  const toUs = (v) => (v * 1e6) / track.timescale;
  const t0 = samples[0].dts;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: track.width, height: track.height },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  const meta = { decoderConfig: { codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description } };
  samples.forEach((s, i) => {
    muxer.addVideoChunkRaw(
      u8.subarray(s.off, s.off + s.size),
      i === 0 || s.key ? "key" : "delta",
      Math.max(0, toUs(s.dts - t0)),
      Math.max(0, toUs(s.dur)),
      i === 0 ? meta : undefined,
      toUs(s.cto),
    );
  });
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
