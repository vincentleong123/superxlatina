# SuperXHentai.com — Cloudflare Tunnel + Express Hardening & SEO Fixes

## Goal
Make `superxhentai.com` (Cloudflare Tunnel → `localhost:7007`, Express app)
production-safe: correct security middleware (helmet/CORS/headers), correct
IP handling behind the tunnel, and no Google deindexation risks.

## Steps
- [x] 1. Diagnose the stack (found: tunnel returns Cloudflare edge 404, app on 7007 is fine)
- [ ] **2. CLOUDFLARE DASHBOARD (YOU MUST DO THIS):** Go to Cloudflare Dashboard → Zero Trust → Networks → Tunnels → select your tunnel → **Public Hostname** tab → Add `superxhentai.com` → HTTP → `localhost:7007`.  
  *Until you do this, the site will keep returning Cloudflare's own 404 page.*
- [x] 3. Added `app.set('trust proxy', 1)` — real visitor IP behind tunnel
- [x] 4. Added `app.disable('x-powered-by')` — hides Express fingerprint
- [x] 5. Added in-memory rate limiter (bot-aware, Googlebot exempted)
- [x] 6. Added canonical-domain 301 middleware (www + old `.site` → `.com`)
- [x] 7. Hardened helmet config: CSP off, cross-origin media allowed
- [x] 8. Added global headers: Referrer-Policy, Permissions-Policy (FLoC/camera/mic/geo off), X-Robots-Tag (index for pages, noindex for admin/api/videos)
- [x] 9. Media routes: `/videos` (CORS + noindex + byte-ranges), `/thumbnails` (CORS + immutable cache)
- [x] 10. Secured cookies with `sameSite: 'lax'` and `secure: req.secure`
- [x] 11. Node syntax verified (`node -c server.js` = OK)

## After you fix the tunnel at Cloudflare dashboard (step 2):
1. **Restart the Express server** — kill the current node process (PID 11552) and restart it:
   ```cmd
   cd "C:\Users\User\Desktop\arnabku - seo-upgrade"
   taskkill /PID 11552 /F
   node server.js
   ```
2. **Verify local server** responds:
   ```cmd
   curl -I http://localhost:7007/
   ```
   You should see `HTTP/1.1 200 OK` with `X-Robots-Tag: index, follow` header.
3. **Verify live site** (may take 1-2 min for tunnel to propagate):
   ```cmd
   curl -I https://superxhentai.com/
   ```
   Should return `HTTP/1.1 200 OK` from your server (not Cloudflare 404).

## Important: old `superxhentai.site` project
The OTHER server at `C:\Users\User\Desktop\superxhentai\server.js` (port 7005, SITE_BASE = `https://superxhentai.site`) is still running (PID 4948, Caddy on 8120). This creates a **duplicate content risk** — Google can index `.site` and `.com` with the same videos.

You should either:
- Shut down the Caddy/Express on port 8120/7005, OR
- Add a 301 redirect from `superxhentai.site` → `superxhentai.com` in Caddy

Shutting down the old server:
```cmd
taskkill /PID 4948 /F
taskkill /PID 9464 /F   # (the superxhentai/node process)
```

