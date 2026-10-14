# HLS Network Inspector

Opens a page in Chromium, listens to Playwright's native network events, and reports `.m3u8` playlist requests (main page, iframes, popups). Use it only on sites you own or are authorized to test. It only observes traffic; it does not bypass DRM, authentication, or access controls.

## Install (local)

Requires Node.js 18.17+ (20 recommended).

```bash
cd hls-inspector
npm install
npx playwright install chromium
# Linux only, if Chromium complains about missing libraries:
npx playwright install --with-deps chromium
```

## Run

```bash
node inspector.js "https://your-site.example/video-page"
```

Options:

| Flag | Meaning | Default |
|---|---|---|
| `--wait <sec>` | Max seconds to listen after page load | 20 |
| `--grace <sec>` | Keep listening this long after the first hit (catches master + media playlists) | 3 |
| `--timeout <sec>` | Navigation timeout | 30 |
| `--out <file>` | JSON output path | results.json |
| `--headed` | Show the browser (local machine with a display) | off |
| `--passive` | Observe only; don't call `play()` or click play buttons | off |
| `--no-sandbox` | Needed in many containers / when running as root | off |
| `--include-sensitive` | Keep Cookie/Authorization values in the JSON | redacted |
| `--verbose` | Print debug info even on success | off |

Examples:

```bash
node inspector.js "https://site.example/watch/123" --wait 40 --out out/watch123.json
node inspector.js "https://site.example/watch/123" --headed --passive --wait 60   # click play yourself
```

## What you get

The terminal prints each playlist URL on its own unindented line (easy to copy), tagged `MASTER`/`MEDIA`, HTTP status, `verified`/`UNVERIFIED`, and hit count. `results.json` contains the same plus request headers, redirect chains, the frame that made the request, and debug info.

- **verified** = the response was 2xx and the body started with `#EXTM3U`.
- **UNVERIFIED** = a `.m3u8` request was seen but it failed, returned non-2xx, or the body could not be read. This is never reported as success.
- Detection is by URL (`.m3u8`, including query strings) **or** by an HLS Content-Type (`mpegurl`), so extensionless playlist URLs are caught too.
- Duplicates are merged by full URL (`count` shows how many times it was requested). Redirects are recorded in `redirectedFrom`.

Exit codes: `0` verified playlist found, `1` nothing detected, `2` error (input, browser, navigation), `3` m3u8 requested but no valid playlist response.

## If nothing is detected

The tool prints and saves: navigation result, frames, `<video>` state (paused, DRM/EME, `blob:` source), request counts by type, `.mpd`/`.mp4`/`.webm` hints (DASH or progressive instead of HLS), console errors, failed requests, and a list of likely reasons. Common causes: the player needs a real click (use `--headed`), a login/consent gate, a longer `--wait`, or the site isn't using HLS.

## Run in a container / server

Dockerfile included (headless only):

```bash
docker build -t hls-inspector .
docker run --rm --init --ipc=host -v "$PWD/out:/out" hls-inspector \
  "https://your-site.example/video-page" --no-sandbox --out /out/results.json
```

On any Linux host without Docker: `npx playwright install --with-deps chromium`, then run with `--no-sandbox` if you're root.

## Notes

- Playlist URLs often contain short-lived signed tokens; treat `results.json` as sensitive.

## Web UI / API (server.js)

`server.js` serves a phone-friendly page at `/` and an API at `POST /api/inspect`.

```bash
AUTH_TOKEN="a-long-random-string-16+" ALLOWED_HOSTS="your-site.example" node server.js
# open http://localhost:3000
```

Env vars: `AUTH_TOKEN` (required), `ALLOWED_HOSTS` (strongly recommended), `MAX_CONCURRENT` (default 1), `PORT`.

```bash
curl -X POST https://YOUR-APP.up.railway.app/api/inspect \
  -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://your-site.example/watch/123","wait":20}'
```

## Deploy on Railway (from a phone)

1. Create a private GitHub repo and upload all files at the repo root (inspector.js, server.js, index.html, package.json, Dockerfile).
2. On railway.com: New Project, Deploy from GitHub repo, pick the repo. Railway builds the Dockerfile automatically.
3. Service, Variables: add `AUTH_TOKEN` (long random string) and `ALLOWED_HOSTS` (your domain).
4. Service, Settings, Networking: Generate Domain.
5. Open the domain on your phone, enter the URL and token.

Chromium is memory-hungry; if the service crashes or restarts, raise its memory limit. Private/internal addresses are blocked, but redirects to internal hosts are not re-checked, so set `ALLOWED_HOSTS`.
