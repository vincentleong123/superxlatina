# Reusable Work Prompt — CDN Embed + Rate-Limit Fix for superxlatina

Paste this into a codegen/assistant session to re-do or continue this task. Adjust paths if the folders moved.

---

## Context

I run two Node/Express scrapers/mirrors on my Windows machine (C:\Users\Admin\Desktop):

1. **`wps-transformer-player`** — a video gallery + custom player. The "transformer" (lib/transformer.js) is a politeness layer for external tube sources: it masks real URLs into signed AES-256-GCM tokens (`/t/:token`), proxies streams (byte-range + HLS), throttles downloads, caches embed resolutions (`resolveTtlMs`), and self-heals expired CDN tokens. It runs on port 7200 and is fronted by a **Caddy** config (Caddyfile) on port 8124 that uses the Souin cache module to cache `/t/*` and `/videos/*` with a 7-day TTL and 30s stale.

2. **`superxlatina`** — a public SEO site (superxlatina.com) on port 7006. It has its own copy of the transformer (utils/transformer.js, same codebase, same token scheme) and an in-app rate limiter that exempts media paths (`/videos`, `/thumbnails`, `/previews`, `/t`, `/tx`). It hotlinks external videos through its own `/t/:token` proxy too, but with **no Caddy cache** in front.

## How media is served today (verified from code)

**wps-transformer-player (server.js):**
- Thumbnails: `v.thumbnail` is always `/img/<id>` → lib/thumb.js downloads the origin image exactly once, saves to `data/thumbs/<id>.<ext>`, then serves from disk forever. Cache-Control max-age=86400.
- Previews: `v.preview` = `/previews/<id>.mp4` → lib/preview.js, only present once a file exists in `data/previews`. Files are pre-cut ~8s middle clips (ffmpeg) built by a background queue that runs ONE at a time with a delay (`delayMs: 5000`) and throttles external downloads to 1MB/s. Local videos: seek-copy from local file. External: full stream downloaded once, middle cut out, temp file deleted. Gallery hover-preview only mounts if `v.preview` exists (views/index.ejs), so hover previews are pure static disk files — zero origin hits while scrolling.
- Playback: local → `/videos/:id` static range serving; external → `/t/:token` masked proxy. Caddy:8124 caches both 7d.

**superxlatina (server.js):**
- Thumbnails: `thumbSrc()` — local videos → `/thumbnails/<id>.jpg` (express.static over `C:\thumbnails`, config.thumbnailsFolder); external videos → `/img/<id>` → same cached download-once thumb.js into `data/thumbs`. Both served from disk, never re-hotlinked.
- Previews: `/previews/<id>.mp4` static from `C:/Users/User/Desktop/hentai_previews` (cut by generate-previews.js) — but **only local videos get `v.preview`**. For external videos `v.preview` is undefined, so the hover engine (views/gallery.ejs and views/player.ejs) falls back to `var src = v.preview || v.video` where `v.video` is the masked `/t/:token` proxy and does a **live Range fetch of ~4–6MB on every hover** (client-side memory cache only, 48MB cap). This is the main rate-limit risk: every mouse-enter over an external card hits the origin CDN from the server IP.

## Decisions already made (stick to these unless something breaks)

- **Don't reinvent the wheel**: reuse the wps transformer + Caddy as the playback layer for superxlatina's external videos. Point superxlatina's external playback at `https://cdn.superxlatina.com/t/<token>` (the wps/Caddy:8124 instance).
- This works with almost no cross-system plumbing because:
  - Both configs share the **same tokenSecret** (`data/config.json` in each) and the **same AES-256-GCM signing scheme** with payload shape `{u, r, t, a}` (wps lib/transformer.js vs superxlatina utils/transformer.js). superxlatina's `signSource()` can mint tokens wps's `/t/:token` verifies.
  - wps streamProxy already sends `Access-Control-Allow-Origin: *` on direct and HLS responses, so cross-origin `<video>` and Range fetch both work.
- **Keep previews local on disk; never hotlink origin for hover previews.** The embed only fixes playback cost (repeats served from 7d Caddy cache). The real fix for the superxlatina external hover-preview risk is to **pre-cut preview files for external videos too** (like generate-previews.js does for local ones), so `v.preview` is always a static `/previews/<id>.mp4`.

## Known constraints / caveats to respect

- Caddy/Souin cache is **in-memory by default** — lost on restart; first-view of each distinct video still fetches origin once. Total distinct-video origin traffic cannot shrink, only repeats get deduped.
- Range requests through the Caddy cache may or may not be served from cache — do not rely on Caddy to dedupe hover-preview Range probes.
- Single point of failure: if the wps/Caddy box dies, superxlatina external playback dies too. Consider a fallback to superxlatina's own `/t/:token`.
- Referer handling: wps only maps hostReferers for `1porn.tv` and `xhamster`/`video-nss.xhcdn.com` (see its data/config.json transformer block). Any external source that needs a site referer and is not mapped will be fetched with an empty referer and may be blocked. Ensure every signed source carries the correct `referer` before minting the token.
- superxlatina config already contains `cdn.superxlatina.com → https://superxlatina.com/` in `hostReferers` — confirm that key is not needed for something else before reusing the domain name.

## Task checklist (when you run this prompt)

1. Read both server.js files, lib/transformer.js (wps), utils/transformer.js (superxlatina), utils/thumb.js, generate-previews.js, views/gallery.ejs + views/player.ejs preview engine, Caddyfile.
2. Verify token compatibility end-to-end (same secret + scheme), and confirm CORS on `/t/:token`.
3. Change superxlatina so external videos' `playback` / `v.video` points at `https://cdn.superxlatina.com/t/<token>` instead of the local `/t/<token>` (keep a config flag to fall back to local proxy).
4. Make hover previews origin-free for ALL videos: generate preview files for external videos in a `data/previews`-style folder (or reuse `C:/Users/User/Desktop/hentai_previews`), set `v.preview` for external videos like it's set for local ones, mirroring lib/preview.js's queue + throttle behavior so the build does not burst the origin.
5. Ensure the in-app rate limiter still exempts `/previews` as it does today; verify hover engine uses the disk file (no Range on `/t/`) when `v.preview` exists.
6. Surface a `resolveTtlMs`-style cache/TTL for the signed token URLs so page HTML doesn't mint a fresh token per render if that's a concern.
7. Do not touch thumbnails — they are already correct (download-once, served from disk).
8. Report exact file:line changes made, and what (if anything) still hits origin on: first load of a video, repeat view, hover preview, thumbnail scroll.