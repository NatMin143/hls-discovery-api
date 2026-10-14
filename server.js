
import express from "express";
import { chromium } from "playwright";
import dns from "node:dns/promises";
import net from "node:net";

const app = express();
const PORT = process.env.PORT || 3000;

const allowedHosts = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "healthy" });
});

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const value = ip.toLowerCase();
    return value === "::1" ||
      value === "::" ||
      !(value.startsWith("fc") ||
        value.startsWith("fd") ||
        value.startsWith("fe8") ||
        value.startsWith("fe9") ||
        value.startsWith("fea") ||
        value.startsWith("feb"));
  }

  return false;
}

async function validateUrl(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  const host = url.hostname.toLowerCase();

  if (!allowedHosts.includes(host)) {
    throw new Error("This hostname is not allowlisted.");
  }

  const addresses = await dns.lookup(host, { all: true });

  if (!addresses.length ||
      addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error("The destination address is not permitted.");
  }

  return url;
}

app.get("/api/inspect", async (req, res) => {
  let browser;

  try {
    if (typeof req.query.url !== "string") {
      return res.status(400).json({
        success: false,
        error: "Provide a URL using ?url="
      });
    }

    const target = await validateUrl(req.query.url);
    const playlists = new Set();

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("request", request => {
      try {
        const url = new URL(request.url());

        if (
          url.protocol === "https:" &&
          /\.m3u8$/i.test(url.pathname)
        ) {
          playlists.add(url.href);
        }
      } catch {}
    });

    await page.goto(target.href, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    await page.waitForTimeout(5000);

    res.json({
      success: true,
      source: target.href,
      count: playlists.size,
      streams: [...playlists].map(url => ({
        type: "hls",
        url
      })),
      note: "Discovery does not guarantee playback."
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API listening on port ${PORT}`);
});
