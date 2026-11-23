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
        await pg.screenshot(path=str(OUT / "01-search.png"))
        await pg.fill("#bib-input", "b10404")
        await pg.click("#search-btn")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=str(OUT / "02-card.png"))
        await pg.click("#play-cta")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=str(OUT / "03-replay-start.png"))
        await pg.evaluate("document.getElementById('scrub').value=330; document.getElementById('scrub').dispatchEvent(new Event('input'))")
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=str(OUT / "04-replay-mid.png"))
        for bt in await pg.query_selector_all("#jumps button"):
            if "Black" in (await bt.inner_text()):
                await bt.click()
        await pg.click("[data-s='60']")
        await pg.wait_for_timeout(2600)
        await pg.screenshot(path=str(OUT / "05-bf.png"))
        await pg.click("#detail summary")
        await pg.evaluate("document.querySelector('.side').scrollTop=9999")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=str(OUT / "06-detail.png"))

        # desktop
        pd = await page(1440, 860, 1)
        await pd.goto(BASE + "?bib=H20117")
        await pd.wait_for_timeout(2500)
        await pd.evaluate("document.getElementById('scrub').value=400; document.getElementById('scrub').dispatchEvent(new Event('input'))")
        await pd.wait_for_timeout(600)
        await pd.screenshot(path=str(OUT / "07-desktop-hm.png"))

        # video (short check that recording produces a blob)
        pv = await page(390, 844, 2)
        await pv.goto(BASE + "?bib=6")
        await pv.wait_for_timeout(2000)
        await pv.click("#share-btn")
        await pv.wait_for_timeout(9000)
        await pv.screenshot(path=str(OUT / "08-video-recording.png"))
        await pv.wait_for_selector("#vm-video:not(.hidden)", timeout=30000)
        info = await pv.evaluate("""async () => {
            const v = document.getElementById('vm-video');
            await new Promise(r => v.readyState >= 1 ? r() : v.onloadedmetadata = r);
            const a = document.getElementById('vm-download');
            const blob = await fetch(a.href).then(r => r.blob());
            return {name: a.download, size: blob.size, type: blob.type, w: v.videoWidth, h: v.videoHeight};
        }""")
        print("video:", info)
        await pv.evaluate("""() => { const v = document.getElementById('vm-video'); v.pause(); v.currentTime = 12; }""")
        await pv.wait_for_timeout(800)
        # grab the last recorded frame from the hidden canvas for inspection
        data = await pv.evaluate("document.getElementById('video-canvas').toDataURL('image/png')")
        import base64
        (OUT / "09-video-lastframe.png").write_bytes(base64.b64decode(data.split(",")[1]))

        print("\n".join(errs) or "no console errors")
        await b.close()


asyncio.run(main())
