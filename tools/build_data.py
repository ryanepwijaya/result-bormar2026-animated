#!/usr/bin/env python3
"""
Build compact per-category JSON for the race replay app.

Input : tools/source/borobudur_marathon_2026_results.xlsx (NOT committed: contains names)
        tools/gpx/{fm,hm,10k}.gpx
Output: data/{fm,hm,10k}.json   (bib numbers only, no names)

Usage : python3 tools/build_data.py [path/to/results.xlsx]

Data model notes
----------------
* Split columns in the results file are SEGMENT times (time between two
  checkpoints), not cumulative times.
* HM and 10K: the first column runs from the start; the last leg
  (last split -> finish) has no column and is derived from the finish time.
* FM: the first column ("KM 10") does NOT start at the start line. Across
  ~1,900 finishers it consistently covers only ~4.4 km, i.e. it runs from a
  checkpoint around KM 5.6 whose start->KM 5.6 segment is missing from the
  export. We add a virtual checkpoint at KM 5.6 (flagged as estimated):
    - finishers: last leg (39.4 -> finish) estimated from the 35 -> 39.4 pace,
      the remainder of the finish time goes to start -> 5.6
    - non-finishers: start -> 5.6 at the pace of the 5.6 -> 10 segment
* All runners are assumed to start at wave 1 (gun time), since wave per
  runner is not in the data.
"""
import json
import math
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
XLSX = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tools/source/borobudur_marathon_2026_results.xlsx"


def hms(h, m=0):
    return h * 3600 + m * 60


CATS = [
    {
        "id": "fm", "sheet": "Marathon", "name": "Marathon", "short": "FM",
        "dist": 42.195, "gpx": "fm.gpx",
        "start": hms(4, 15),
        "waves": ["04:15", "04:20", "04:25", "04:30"],
        "cops": [
            {"name": "COP 1", "km": 10, "close": hms(6, 5)},
            {"name": "COP 2", "km": 20, "close": hms(7, 35)},
            {"name": "COP 3", "km": 34.5, "close": hms(9, 50)},
        ],
        "finishClose": hms(11, 0),
        "blackFlag": hms(9, 45),
        "virtual": {"km": 5.6, "segLen": 4.4},  # hidden checkpoint before "KM 10"
    },
    {
        "id": "hm", "sheet": "Half Marathon", "name": "Half Marathon", "short": "HM",
        "dist": 21.0975, "gpx": "hm.gpx",
        "start": hms(4, 55),
        "waves": ["04:55", "05:00", "05:05", "05:10"],
        "cops": [
            {"name": "COP 1", "km": 5, "close": hms(5, 58)},
            {"name": "COP 2", "km": 9.5, "close": hms(6, 42)},
            {"name": "COP 3", "km": 17.5, "close": hms(8, 10)},
        ],
        "finishClose": hms(8, 50),
        "blackFlag": None,
        "virtual": None,
    },
    {
        "id": "10k", "sheet": "10K", "name": "10K", "short": "10K",
        "dist": 10.0, "gpx": "10k.gpx",
        "start": hms(5, 40),
        "waves": ["05:40"],
        "cops": [
            {"name": "COP 1", "km": 2.79, "close": hms(6, 8)},
        ],
        "finishClose": hms(7, 40),
        "blackFlag": None,
        "virtual": None,
    },
]

STATUS = {"Finisher": 0, "QRY": 1, "DNF": 2, "DQ": 3, "DNS": 4}


def sec(v):
    if v is None:
        return None
    s = str(v).strip()
    if ":" not in s:
        return None
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
    except ValueError:
        return None
    return None


def load_route(path):
    s = path.read_text()
    pts = [(float(a), float(b)) for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', s)]
    if not pts:
        pts = [(float(b), float(a)) for a, b in re.findall(r'lon="([-\d.]+)"\s+lat="([-\d.]+)"', s)]
    # dedupe consecutive identical/near-identical points
    clean = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - clean[-1][0]) > 1e-7 or abs(p[1] - clean[-1][1]) > 1e-7:
            clean.append(p)
    lat0 = sum(p[0] for p in clean) / len(clean)
    lon0 = sum(p[1] for p in clean) / len(clean)
    kx = 6371000 * math.cos(math.radians(lat0)) * math.pi / 180
    ky = 6371000 * math.pi / 180
    xy = [((lon - lon0) * kx, (lat - lat0) * ky) for lat, lon in clean]
    length = sum(math.dist(a, b) for a, b in zip(xy, xy[1:]))
    flat = []
    for x, y in xy:
        flat += [round(x, 1), round(y, 1)]
    return flat, length


def build(cat, wb):
    ws = wb[cat["sheet"]]
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h) if h is not None else "" for h in rows[0]]
    col = {h: i for i, h in enumerate(head)}
    split_cols = [i for i, h in enumerate(head) if h.startswith("KM ")]
    split_km = [float(head[i][3:]) for i in split_cols]

    v = cat["virtual"]
    km = [0.0] + ([v["km"]] if v else []) + split_km + [cat["dist"]]
    est = [False] + ([True] if v else []) + [False] * len(split_km) + [False]
    K = len(km)
    off = 2 if v else 1  # index in km[] of first real split column

    bibs, sts, times, pos, gender, catname, catpos = [], [], [], [], [], [], []
    noshow_bib, noshow_st = [], []
    stats = {"gaps": 0, "virtual_fallback": 0, "bad": 0}

    for r in rows[1:]:
        bib = r[col["Bib No"]]
        if bib is None:
            continue
        # bib letter prefix = registration channel; numbers alone are unique
        bib = re.sub(r"^[A-Za-z]+", "", str(bib).strip())
        status = str(r[col["Status"]] or "").strip()
        st = STATUS.get(status, 1)
        F = sec(r[col["Time"]])
        segs = [sec(r[i]) for i in split_cols]

        t = [-1] * K
        t[0] = 0

        # forward cumulative over real split columns, stop at first gap
        cum_from_first = []  # cumulative relative to the first column's start
        acc = 0.0
        for sgm in segs:
            if sgm is None or sgm <= 0:
                break
            acc += sgm
            cum_from_first.append(acc)
        if len(cum_from_first) < len(segs) and any(x is not None for x in segs[len(cum_from_first):]):
            stats["gaps"] += 1

        base = 0.0
        if v and cum_from_first:
            # time from start to the virtual checkpoint
            s_first = segs[0]
            pace = s_first / v["segLen"]
            if len(cum_from_first) >= 2:
                # guard against an anomalous first segment (e.g. long stop):
                # do not assume a start pace slower than 1.15x the next segment
                p2 = segs[1] / (split_km[1] - split_km[0])
                pace = min(pace, p2 * 1.15)
            fallback = pace * v["km"]
            base = fallback
            if st == 0 and F and len(cum_from_first) == len(segs):
                last_leg = segs[-1] / (split_km[-1] - split_km[-2]) * (cat["dist"] - split_km[-1])
                b = F - cum_from_first[-1] - last_leg
                if 0.6 * fallback <= b <= 1.8 * fallback:
                    base = b
                else:
                    stats["virtual_fallback"] += 1
            t[1] = round(base)

        for j, c in enumerate(cum_from_first):
            t[off + j] = round(base + c)

        if st == 0 and F:
            t[K - 1] = round(F)
            # sanity: finish must be after last known checkpoint
            last_known = max(x for x in t[:-1] if x >= 0)
            if F <= last_known:
                stats["bad"] += 1
                # drop splits, keep only finish
                t = [0] + [-1] * (K - 2) + [round(F)]
        elif st == 0 and not F:
            st = 1  # finisher without time: treat as unknown

        has_progress = any(x > 0 for x in t[1:])
        if not has_progress:
            noshow_bib.append(bib)
            noshow_st.append(4 if status in ("", "QRY", "DNS") and st != 3 else st)
            continue

        bibs.append(bib)
        sts.append(st)
        times += t
        p = r[col["Pos"]] if "Pos" in col else None
        pos.append(int(p) if (st == 0 and isinstance(p, (int, float))) else 0)
        g = str(r[col["Gender"]] or "")
        gender.append("M" if g.startswith("M") else ("F" if g.startswith("F") else ""))
        catname.append(str(r[col["Category"]] or "") if st == 0 else "")
        cp = r[col["Category_Pos"]] if "Category_Pos" in col else None
        catpos.append(int(cp) if (st == 0 and isinstance(cp, (int, float))) else 0)

    route, length = load_route(ROOT / "tools/gpx" / cat["gpx"])
    out = {
        "id": cat["id"], "name": cat["name"], "short": cat["short"],
        "dist": cat["dist"], "start": cat["start"], "waves": cat["waves"],
        "cops": cat["cops"], "finishClose": cat["finishClose"],
        "blackFlag": cat["blackFlag"],
        "km": km, "kmEst": est,
        "routeLen": round(length, 1), "route": route,
        "n": len(bibs), "K": K,
        "bib": bibs, "st": sts, "t": times,
        "pos": pos, "g": gender, "cat": catname, "catPos": catpos,
        "noshow": {"bib": noshow_bib, "st": noshow_st},
    }
    dst = ROOT / "data" / f"{cat['id']}.json"
    dst.write_text(json.dumps(out, separators=(",", ":")))
    counts = {}
    for s in sts:
        counts[s] = counts.get(s, 0) + 1
    print(f"{cat['id']}: runners={len(bibs)} noshow={len(noshow_bib)} status={counts} "
          f"route={length/1000:.2f}km pts={len(route)//2} {stats} -> {dst.stat().st_size/1024:.0f} KB")


def main():
    wb = openpyxl.load_workbook(XLSX, read_only=True)
    for cat in CATS:
        build(cat, wb)


if __name__ == "__main__":
    main()
