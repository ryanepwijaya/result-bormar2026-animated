"""Headless UI smoke test: serves repo files via Playwright routing and takes screenshots.
Usage: python3 tools/ui_test.py OUTDIR
"""
import asyncio
import mimetypes
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots")
OUT.mkdir(parents=True, exist_ok=True)
BASE = "https://replay.test/"


async def serve(route):
    url = route.request.url.split("?")[0]
    rel = url[len(BASE):] or "index.html"
    f = ROOT / rel
    if not f.is_file():
        await route.fulfill(status=404, body="nf")
        return
    ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
    if f.suffix in (".js", ".mjs"):
        ctype = "text/javascript"
    if f.suffix == ".webmanifest":
        ctype = "application/manifest+json"
    await route.fulfill(status=200, body=f.read_bytes(), headers={"content-type": ctype})


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
        errs = []

        async def page(w, h, dpr):
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr, service_workers="block")
            await ctx.route(BASE + "**", serve)
            pg = await ctx.new_page()
            pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
            return pg

        pg = await page(390, 844, 2)
        await pg.goto(BASE)
        await pg.wait_for_function("!document.getElementById('search-btn').disabled", timeout=20000)
        for bib in ["B10404", "10627", "20117"]:
            await pg.fill("#bib-input", bib)
            await pg.click("#search-btn")
            await pg.wait_for_timeout(150)
        # 20117 is HM -> must be refused
        await pg.screenshot(path=str(OUT / "00-refused.png"))
        print("refusal:", await pg.inner_text("#search-msg"))
        await pg.fill("#bib-input", "12600")
        await pg.click("#search-btn")
        await pg.wait_for_timeout(150)
        await pg.screenshot(path=str(OUT / "01-picks.png"))
        await pg.click("#play-cta")
        await pg.wait_for_timeout(800)
        await pg.evaluate("document.getElementById('scrub').value=330; document.getElementById('scrub').dispatchEvent(new Event('input'))")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=str(OUT / "02-vs-collapsed.png"))
        await pg.click("#info-btn")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path=str(OUT / "03-vs-open.png"))
        await pg.evaluate("document.getElementById('scrub').value=850; document.getElementById('scrub').dispatchEvent(new Event('input'))")
        await pg.wait_for_timeout(400)
        await pg.evaluate("document.getElementById('sheet').scrollTop=0")
        await pg.screenshot(path=str(OUT / "04-vs-open-late.png"))

        ps = await page(390, 844, 2)
        await ps.goto(BASE + "?bib=20117")
        await ps.wait_for_timeout(2500)
        await ps.evaluate("document.getElementById('scrub').value=400; document.getElementById('scrub').dispatchEvent(new Event('input'))")
        await ps.wait_for_timeout(500)
        await ps.screenshot(path=str(OUT / "05-single-hm.png"))

        pd = await page(1440, 860, 1)
        await pd.goto(BASE + "?bib=10404,10627,6")
        await pd.wait_for_timeout(2500)
        await pd.evaluate("document.getElementById('scrub').value=300; document.getElementById('scrub').dispatchEvent(new Event('input'))")
        await pd.wait_for_timeout(600)
        await pd.screenshot(path=str(OUT / "06-desktop-vs.png"))

        pv = await page(390, 844, 2)
        await pv.goto(BASE + "?bib=10404,10627,12600")
        await pv.wait_for_timeout(2000)
        await pv.click("#share-btn")
        await pv.wait_for_timeout(9500)
        data = await pv.evaluate("document.getElementById('video-canvas').toDataURL('image/png')")
        import base64
        (OUT / "07-video-mid.png").write_bytes(base64.b64decode(data.split(",")[1]))
        await pv.wait_for_selector("#vm-video:not(.hidden)", timeout=30000)
        info = await pv.evaluate("""async () => {
            const v = document.getElementById('vm-video');
            await new Promise(r => v.readyState >= 1 ? r() : v.onloadedmetadata = r);
            const a = document.getElementById('vm-download');
            const blob = await fetch(a.href).then(r => r.blob());
            return {name: a.download, size: blob.size, type: blob.type, w: v.videoWidth, h: v.videoHeight};
        }""")
        print("video:", info)
        b64 = await pv.evaluate("""async () => {
            const blob = await fetch(document.getElementById('vm-download').href).then(r => r.blob());
            const buf = new Uint8Array(await blob.arrayBuffer());
            let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            return btoa(s);
        }""")
        import base64 as _b
        (OUT / ("video." + info["name"].rsplit(".", 1)[1])).write_bytes(_b.b64decode(b64))
        data = await pv.evaluate("document.getElementById('video-canvas').toDataURL('image/png')")
        (OUT / "08-video-outro.png").write_bytes(base64.b64decode(data.split(",")[1]))

        print("\n".join(errs) or "no console errors")
        await b.close()


asyncio.run(main())
