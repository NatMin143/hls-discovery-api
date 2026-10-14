#!/usr/bin/env node
'use strict';

/**
 * HLS Network Inspector
 * Opens a page in Chromium, listens to Playwright's native network events
 * (all pages/frames in the context), and reports .m3u8 playlist requests.
 *
 * Use only on sites you own or are authorized to test. This tool only
 * observes traffic; it does not bypass DRM, authentication or access controls.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { chromium } = require('playwright');

const HLS_URL_RE = /\.m3u8/i;
const HLS_CT_RE = /mpegurl/i; // application/vnd.apple.mpegurl, application/x-mpegURL, audio/mpegurl
const STREAM_HINT_RE = /\.(mpd|m4s|mp4|webm|ts)(\?|#|$)/i;
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);
const PLAY_SELECTORS = [
  '.vjs-big-play-button',
  '.jw-icon-display',
  '.plyr__control--overlaid',
  '.mejs__overlay-button',
  'button[aria-label*="play" i]',
  '[class*="play-button" i]',
  '[class*="play_button" i]',
  'button.play',
];

const HELP = `
HLS Network Inspector

Usage:
  node inspector.js <page-url> [options]

Options:
  --wait <sec>         Max seconds to listen after page load      (default 20)
  --grace <sec>        Keep listening this long after first hit   (default 3)
  --timeout <sec>      Navigation timeout                         (default 30)
  --out <file>         JSON output file                           (default results.json)
  --headed             Show the browser window (local machine only)
  --passive            Observe only: don't call play() or click play buttons
  --no-sandbox         Pass --no-sandbox to Chromium (needed in many containers)
  --include-sensitive  Keep Cookie/Authorization header values in the JSON
  --verbose            Always print debug details, even on success
  -h, --help           Show this help

Exit codes: 0 = verified playlist found, 1 = nothing detected,
            2 = error (bad input, browser, navigation), 3 = m3u8 request seen
            but no valid playlist response.
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usageError(msg) {
  console.error(`Error: ${msg}\n${HELP}`);
  process.exit(2);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        wait: { type: 'string', default: '20' },
        grace: { type: 'string', default: '3' },
        timeout: { type: 'string', default: '30' },
        out: { type: 'string', default: 'results.json' },
        headed: { type: 'boolean', default: false },
        passive: { type: 'boolean', default: false },
        'no-sandbox': { type: 'boolean', default: false },
        'include-sensitive': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    usageError(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (positionals.length !== 1) usageError('Expected exactly one page URL.');

  let url;
  try {
    url = new URL(positionals[0]);
  } catch {
    usageError(`Invalid URL: ${positionals[0]}`);
  }
  if (!/^https?:$/.test(url.protocol)) usageError('Only http(s) URLs are supported.');

  const num = (name) => {
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < 0) usageError(`--${name} must be a non-negative number.`);
    return n;
  };

  return {
    url: url.href,
    wait: num('wait'),
    grace: num('grace'),
    timeout: num('timeout'),
    out: values.out,
    headed: values.headed,
    passive: values.passive,
    noSandbox: values['no-sandbox'],
    includeSensitive: values['include-sensitive'],
    verbose: values.verbose,
  };
}

function redact(headers, keep) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = !keep && SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

function frameUrlOf(request) {
  try {
    return request.frame().url();
  } catch {
    return null; // e.g. service-worker requests have no frame
  }
}

function redirectChain(request) {
  const chain = [];
  let r = request.redirectedFrom();
  while (r) {
    chain.unshift(r.url());
    r = r.redirectedFrom();
  }
  return chain;
}

async function anyVideoPlaying(page) {
  for (const frame of page.frames()) {
    try {
      const playing = await frame.evaluate(() =>
        [...document.querySelectorAll('video')].some((v) => !v.paused && v.readyState > 2)
      );
      if (playing) return true;
    } catch {}
  }
  return false;
}

async function tryStartPlayback(page, clicked) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        document.querySelectorAll('video').forEach((v) => {
          if (v.paused) {
            v.muted = true;
            v.play().catch(() => {});
          }
        });
      });
    } catch {}
  }
  if (await anyVideoPlaying(page)) return; // don't click play on something already playing
  for (const frame of page.frames()) {
    for (const sel of PLAY_SELECTORS) {
      const key = `${frame.url()}::${sel}`;
      if (clicked.has(key)) continue;
      try {
        const loc = frame.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) {
          clicked.add(key);
          await loc.click({ timeout: 1500 });
        }
      } catch {}
    }
  }
}

async function collectPageDebug(page) {
  const info = { finalPageUrl: null, pageTitle: null, frames: [], videos: [] };
  try {
    info.finalPageUrl = page.url();
    info.pageTitle = await page.title();
  } catch {}
  for (const frame of page.frames()) {
    info.frames.push({ url: frame.url(), name: frame.name(), isMain: frame === page.mainFrame() });
    try {
      const vids = await frame.evaluate(() =>
        [...document.querySelectorAll('video')].map((v) => ({
          src: (v.currentSrc || v.src || '').slice(0, 300) || null,
          paused: v.paused,
          readyState: v.readyState,
          networkState: v.networkState,
          errorCode: v.error ? v.error.code : null,
          hasMediaKeys: !!v.mediaKeys,
          nativeHls: v.canPlayType('application/vnd.apple.mpegurl') || null,
        }))
      );
      for (const v of vids) info.videos.push({ frameUrl: frame.url(), ...v });
    } catch {}
  }
  return info;
}

function diagnose({ nav, debug, page, detectedCount }) {
  const why = [];
  if (!nav.ok && !nav.timedOut) {
    why.push(`Navigation failed: ${nav.error}. Check the URL, DNS, TLS and network access from this machine.`);
  } else if (nav.timedOut) {
    why.push(`Navigation hit the ${nav.timeout}s timeout (${nav.error}). The page may be slow; try a larger --timeout.`);
  }
  if (nav.status && nav.status >= 400) {
    why.push(`The page itself returned HTTP ${nav.status}. A login, geo-block or bot protection may be in the way.`);
  }
  if (debug.pageCrashed) why.push('The page crashed. Try running again, or use --no-sandbox in a container.');

  const videos = page.videos;
  if (videos.length === 0) {
    why.push(
      'No <video> element found in any frame. The player may load lazily, sit behind a login/consent/age gate, ' +
        'live in a shadow DOM or a frame that did not load, or need a longer --wait.'
    );
  } else {
    if (videos.every((v) => v.paused)) {
      why.push(
        'A <video> exists but never started playing. The player probably needs a real user interaction. ' +
          'Try --headed and click play yourself while the tool listens.'
      );
    }
    if (videos.some((v) => v.hasMediaKeys)) {
      why.push('Encrypted Media Extensions (DRM) are in use. This tool only observes; it does not bypass DRM.');
    }
    if (videos.some((v) => v.src && v.src.startsWith('blob:'))) {
      why.push(
        'The player uses a blob: source (Media Source Extensions, e.g. hls.js/Shaka) but no .m3u8 request was seen. ' +
          'It may be DASH/progressive, or the playlist URL has no ".m3u8" and an unusual Content-Type.'
      );
    }
  }
  const hints = debug.streamHints;
  if (hints.mpd) why.push(`Saw ${hints.mpd.count} .mpd request(s): the site likely uses DASH, not HLS (e.g. ${hints.mpd.sample}).`);
  if (hints.mp4) why.push(`Saw ${hints.mp4.count} .mp4 request(s): progressive download is possible (e.g. ${hints.mp4.sample}).`);
  if (hints.webm) why.push(`Saw ${hints.webm.count} .webm request(s) (e.g. ${hints.webm.sample}).`);
  if (debug.failedRequests.length) why.push(`${debug.failedRequests.length}+ requests failed; see debug.failedRequests.`);
  if (detectedCount === 0) {
    why.push(
      'Other things to try: increase --wait, run with --headed to watch the player, make sure the URL is the page ' +
        'that actually contains the player (not a wrapper), and confirm the stream is reachable from this network.'
    );
  }
  return why;
}

function printReport(result, opts) {
  const line = '═'.repeat(64);
  const { playlists, verifiedCount } = result;
  console.log('');
  console.log(line);
  if (verifiedCount > 0) {
    console.log(`✅ HLS PLAYLIST FOUND — ${verifiedCount} verified (${playlists.length} total m3u8 URL(s))`);
  } else if (playlists.length > 0) {
    console.log('⚠️  m3u8 REQUEST(S) SEEN, BUT NO VALID PLAYLIST RESPONSE');
  } else {
    console.log('❌ NO .m3u8 PLAYLIST DETECTED');
  }
  console.log(line);

  playlists.forEach((p, i) => {
    const tags = [
      p.playlistType !== 'unknown' ? p.playlistType.toUpperCase() : 'PLAYLIST',
      p.status ? `HTTP ${p.status}` : p.failure ? `FAILED (${p.failure})` : 'no response',
      p.verified ? 'verified' : 'UNVERIFIED',
      `seen ${p.count}×`,
    ];
    console.log(`\n[${i + 1}] ${tags.join(' • ')}`);
    console.log(p.url); // on its own line, unindented, for easy copying
    if (p.redirectedFrom.length) console.log(`   redirected from: ${p.redirectedFrom.join(' → ')}`);
    if (p.frameUrl) console.log(`   requested by frame: ${p.frameUrl}`);
    if (p.requestHeaders && (p.requestHeaders.referer || p.requestHeaders.origin)) {
      console.log(`   Referer: ${p.requestHeaders.referer || '-'}  Origin: ${p.requestHeaders.origin || '-'}`);
    }
  });

  if (verifiedCount === 0 || opts.verbose) {
    console.log('\n--- Debug information ---');
    console.log(`Page: ${result.page.finalPageUrl} ("${result.page.pageTitle}")`);
    console.log(`Navigation: ${result.navigation.ok ? `ok (HTTP ${result.navigation.status})` : `FAILED: ${result.navigation.error}`}`);
    console.log(`Frames (${result.page.frames.length}): ${result.page.frames.map((f) => f.url || '(empty)').join(' | ')}`);
    console.log(`Video elements: ${result.page.videos.length}`);
    result.page.videos.forEach((v, i) =>
      console.log(`  #${i + 1} paused=${v.paused} readyState=${v.readyState} drm=${v.hasMediaKeys} src=${v.src || '(none)'}`)
    );
    console.log(`Requests by type: ${JSON.stringify(result.debug.requestCountsByType)}`);
    if (result.debug.consoleErrors.length) console.log(`Console errors: ${result.debug.consoleErrors.slice(0, 5).join(' | ')}`);
    if (result.debug.failedRequests.length) {
      console.log('Failed requests (first 5):');
      result.debug.failedRequests.slice(0, 5).forEach((f) => console.log(`  ${f.failure} ${f.url.slice(0, 160)}`));
    }
    if (result.diagnosis.length) {
      console.log('\nLikely reasons / next steps:');
      result.diagnosis.forEach((d) => console.log(`  • ${d}`));
    }
  }
  console.log(`\nResults saved to: ${path.resolve(opts.out)}`);
  console.log('Note: playlist URLs may contain short-lived tokens; treat the JSON file accordingly.\n');
}

async function main() {
  const opts = parseCli();
  const startedAt = Date.now();
  const entries = new Map(); // url -> entry (dedupe)
  const pending = new Set();
  const clicked = new Set();
  const debug = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    requestCountsByType: {},
    streamHints: {},
    pageCrashed: false,
  };
  let pageCount = 0;
  let firstHitAt = null;
  let aborted = false;
  let closing = false;
  let browserDied = false;

  process.once('SIGINT', () => {
    console.log('\nInterrupted: finishing up and saving what was found so far...');
    aborted = true;
  });

  const track = (p) => {
    const t = Promise.resolve(p)
      .catch(() => {})
      .finally(() => pending.delete(t));
    pending.add(t);
  };

  const getOrCreate = (request, detectedBy) => {
    const url = request.url();
    let e = entries.get(url);
    if (!e) {
      e = {
        url,
        method: request.method(),
        detectedBy: [detectedBy],
        count: 0,
        firstSeenMs: Date.now() - startedAt,
        resourceType: request.resourceType(),
        frameUrl: frameUrlOf(request),
        redirectedFrom: redirectChain(request),
        requestHeaders: null,
        status: null,
        statuses: {},
        contentType: null,
        redirectHop: false,
        location: null,
        playlistType: 'unknown',
        verified: false,
        bodyChecked: false,
        bodyError: null,
        failure: null,
      };
      entries.set(url, e);
    } else if (!e.detectedBy.includes(detectedBy)) {
      e.detectedBy.push(detectedBy);
    }
    return e;
  };

  const captureHeaders = (e, request) => {
    if (e.requestHeaders) return;
    e.requestHeaders = redact(request.headers(), opts.includeSensitive); // immediate fallback
    track(
      request.allHeaders().then((h) => {
        e.requestHeaders = redact(h, opts.includeSensitive); // full set incl. cookies etc.
      })
    );
  };

  const markHit = () => {
    if (!firstHitAt) firstHitAt = Date.now();
  };

  let browser;
  try {
    const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
    if (opts.noSandbox) launchArgs.push('--no-sandbox');
    try {
      browser = await chromium.launch({ headless: !opts.headed, args: launchArgs });
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`Could not launch Chromium: ${msg.split('\n')[0]}`);
      if (/Executable doesn't exist/i.test(msg)) console.error('Run: npx playwright install chromium');
      else if (/shared libraries|missing dependencies|Host system is missing/i.test(msg))
        console.error('Run: npx playwright install --with-deps chromium  (Linux needs system libraries)');
      else if (/sandbox/i.test(msg)) console.error('Try again with --no-sandbox (containers/root).');
      else if (opts.headed) console.error('--headed needs a display. Remove it on servers/containers.');
      process.exitCode = 2;
      return;
    }
    browser.on('disconnected', () => {
      if (!closing) {
        browserDied = true;
        aborted = true;
      }
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    // ---- Native Playwright network events (context-level: every page, frame, popup) ----
    context.on('request', (request) => {
      const url = request.url();
      const rt = request.resourceType();
      debug.requestCountsByType[rt] = (debug.requestCountsByType[rt] || 0) + 1;

      if (!HLS_URL_RE.test(url)) {
        const m = url.match(STREAM_HINT_RE);
        if (m) {
          const ext = m[1].toLowerCase();
          const h = (debug.streamHints[ext] ||= { count: 0, sample: url.slice(0, 200) });
          h.count++;
        }
        return;
      }
      const e = getOrCreate(request, 'url');
      e.count++;
      captureHeaders(e, request);
      markHit();
    });

    context.on('response', (response) => {
      const request = response.request();
      const url = request.url();
      const respHeaders = response.headers();
      const ct = respHeaders['content-type'] || '';
      const byUrl = HLS_URL_RE.test(url);
      const byCt = HLS_CT_RE.test(ct);
      if (!byUrl && !byCt) return;

      const e = getOrCreate(request, byUrl ? 'url' : 'content-type');
      if (!byUrl) {
        // detected only by content-type, so there was no request-phase hit
        e.count++;
        captureHeaders(e, request);
        markHit();
      }
      const status = response.status();
      e.status = status;
      e.statuses[status] = (e.statuses[status] || 0) + 1;
      e.contentType = ct || null;
      e.redirectHop = status >= 300 && status < 400;
      if (e.redirectHop) e.location = respHeaders.location || null;

      if (status >= 200 && status < 300 && !e.bodyChecked) {
        e.bodyChecked = true;
        track(
          response
            .body()
            .then((buf) => {
              const text = buf.subarray(0, 8192).toString('utf8').replace(/^\uFEFF/, '').trimStart();
              e.verified = text.startsWith('#EXTM3U');
              if (e.verified) {
                if (/#EXT-X-STREAM-INF|#EXT-X-MEDIA:/.test(text)) e.playlistType = 'master';
                else if (/#EXTINF|#EXT-X-TARGETDURATION/.test(text)) e.playlistType = 'media';
              }
            })
            .catch((err) => {
              e.bodyError = String(err.message || err).split('\n')[0];
            })
        );
      }
    });

    context.on('requestfailed', (request) => {
      const failure = request.failure();
      const errorText = failure ? failure.errorText : 'unknown';
      if (debug.failedRequests.length < 25) {
        debug.failedRequests.push({ url: request.url(), failure: errorText, resourceType: request.resourceType() });
      }
      if (HLS_URL_RE.test(request.url())) {
        getOrCreate(request, 'url').failure = errorText;
        markHit();
      }
    });

    context.on('page', (p) => {
      pageCount++;
      p.on('console', (m) => {
        if (m.type() === 'error' && debug.consoleErrors.length < 20) debug.consoleErrors.push(m.text().slice(0, 300));
      });
      p.on('pageerror', (err) => {
        if (debug.pageErrors.length < 20) debug.pageErrors.push(String((err && err.message) || err).slice(0, 300));
      });
      p.on('crash', () => {
        debug.pageCrashed = true;
        aborted = true;
      });
    });

    const page = await context.newPage();

    // ---- Navigate ----
    console.log(`Opening ${opts.url}`);
    const nav = { ok: false, status: null, error: null, timedOut: false, timeout: opts.timeout };
    try {
      const resp = await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout * 1000 });
      nav.ok = true;
      nav.status = resp ? resp.status() : null;
      console.log(`Page loaded (HTTP ${nav.status}). Listening up to ${opts.wait}s...`);
    } catch (err) {
      nav.error = String(err.message || err).split('\n')[0];
      nav.timedOut = err.name === 'TimeoutError';
      if (nav.timedOut) console.log(`Navigation timed out after ${opts.timeout}s; listening anyway...`);
      else console.log(`Navigation failed: ${nav.error}`);
    }

    // ---- Wait for the player; try to start playback ----
    if (nav.ok || nav.timedOut) {
      const deadline = Date.now() + opts.wait * 1000;
      let lastPlayAttempt = 0;
      while (!aborted && Date.now() < deadline) {
        if (firstHitAt && Date.now() - firstHitAt >= opts.grace * 1000) break;
        if (!opts.passive && !page.isClosed() && Date.now() - lastPlayAttempt >= 2000) {
          lastPlayAttempt = Date.now();
          await tryStartPlayback(page, clicked).catch(() => {});
        }
        await sleep(250);
      }
    }

    await Promise.race([Promise.allSettled([...pending]), sleep(5000)]);

    // ---- Build results ----
    const pageInfo = browserDied ? { finalPageUrl: null, pageTitle: null, frames: [], videos: [] } : await collectPageDebug(page);
    const all = [...entries.values()];
    const referenced = new Set(all.flatMap((e) => e.redirectedFrom));
    const rank = (p) => (p.verified && p.playlistType === 'master' ? 0 : p.verified ? 1 : 2);
    const playlists = all
      .filter((e) => !(e.redirectHop && referenced.has(e.url))) // drop pure redirect hops already shown as a chain
      .map(({ bodyChecked, ...rest }) => rest)
      .sort((a, b) => rank(a) - rank(b) || a.firstSeenMs - b.firstSeenMs);
    const verifiedCount = playlists.filter((p) => p.verified).length;

    const result = {
      inputUrl: opts.url,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      settings: { wait: opts.wait, grace: opts.grace, timeout: opts.timeout, passive: opts.passive },
      found: playlists.length > 0,
      verifiedCount,
      primaryUrl: playlists.find((p) => p.verified)?.url || null,
      playlists,
      navigation: { ok: nav.ok, status: nav.status, error: nav.error, timedOut: nav.timedOut },
      page: pageInfo,
      debug: { ...debug, pagesOpened: pageCount, interrupted: aborted, browserDied },
    };
    result.diagnosis = diagnose({ nav, debug, page: pageInfo, detectedCount: playlists.length });

    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(opts.out, JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Could not write ${opts.out}: ${err.message}`);
    }

    printReport(result, opts);

    if (browserDied || (!nav.ok && !nav.timedOut)) process.exitCode = 2;
    else if (verifiedCount > 0) process.exitCode = 0;
    else if (playlists.length > 0) process.exitCode = 3;
    else process.exitCode = 1;
  } catch (err) {
    console.error(`Unexpected error: ${err.stack || err}`);
    process.exitCode = 2;
  } finally {
    closing = true;
    if (browser) await browser.close().catch(() => {});
  }
}

main();
