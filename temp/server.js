const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json({ limit: "10mb" }));

function okUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function preparePage(page, options = {}) {
  const {
    viewport = { width: 1280, height: 720 },
    userAgent,
    extraHeaders,
    timeoutMs = 60000,
    waitUntil = "networkidle2",
  } = options;

  if (viewport?.width && viewport?.height) {
    await page.setViewport({ width: viewport.width, height: viewport.height });
  }
  if (userAgent) await page.setUserAgent(userAgent);
  if (extraHeaders) await page.setExtraHTTPHeaders(extraHeaders);

  return { timeoutMs, waitUntil };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "puppeteer-api" });
});

/**
 * POST /content
 * body: { url, options? }
 * returns: { url, title, html }
 */
app.post("/content", async (req, res) => {
  const { url, options } = req.body || {};
  if (!okUrl(url)) return res.status(400).json({ error: "Niepoprawny url" });

  try {
    const result = await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const { timeoutMs, waitUntil } = await preparePage(page, options);

      await page.goto(url, { waitUntil, timeout: timeoutMs });
      const title = await page.title();
      const html = await page.content();

      return { url, title, html };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "Błąd content", details: String(e) });
  }
});

/**
 * POST /screenshot
 * body: { url, fullPage?, type?, quality?, options? }
 * returns: image binary
 */
app.post("/screenshot", async (req, res) => {
  const { url, fullPage = true, type = "png", quality, options } = req.body || {};
  if (!okUrl(url)) return res.status(400).json({ error: "Niepoprawny url" });

  try {
    const buffer = await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const { timeoutMs, waitUntil } = await preparePage(page, options);

      await page.goto(url, { waitUntil, timeout: timeoutMs });

      const shotOptions = { fullPage, type: type === "jpeg" ? "jpeg" : "png" };
      if (shotOptions.type === "jpeg" && typeof quality === "number") {
        shotOptions.quality = quality;
      }

      return await page.screenshot(shotOptions);
    });

    res.setHeader("Content-Type", type === "jpeg" ? "image/jpeg" : "image/png");
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: "Błąd screenshot", details: String(e) });
  }
});

/**
 * POST /pdf
 * body: { url, format?, printBackground?, options? }
 * returns: pdf binary
 */
app.post("/pdf", async (req, res) => {
  const { url, format = "A4", printBackground = true, options } = req.body || {};
  if (!okUrl(url)) return res.status(400).json({ error: "Niepoprawny url" });

  try {
    const buffer = await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const { timeoutMs, waitUntil } = await preparePage(page, options);

      await page.goto(url, { waitUntil, timeout: timeoutMs });

      return await page.pdf({
        format,
        printBackground,
      });
    });

    res.setHeader("Content-Type", "application/pdf");
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: "Błąd PDF", details: String(e) });
  }
});

/**
 * POST /run
 * body:
 * {
 *   url: "https://...",
 *   options?: {...},
 *   steps?: [
 *     { action: "waitForSelector", selector: "#id", timeoutMs?: 60000 },
 *     { action: "type", selector: "#id", text: "abc", delay?: 0 },
 *     { action: "click", selector: "button" },
 *     { action: "press", key: "Enter" },
 *     { action: "waitForTimeout", ms: 1000 },
 *     { action: "waitForNavigation", waitUntil?: "networkidle2", timeoutMs?: 60000 },
 *     { action: "evaluate", fn: "return document.title;" }
 *   ],
 *   result?: {
 *     content?: true,
 *     screenshot?: { enabled?: true, fullPage?: true, type?: "png"|"jpeg", quality?: 80 }
 *   }
 * }
 */
app.post("/run", async (req, res) => {
  const { url, options, steps = [], result = {} } = req.body || {};
  if (!okUrl(url)) return res.status(400).json({ error: "Niepoprawny url" });
  if (!Array.isArray(steps)) return res.status(400).json({ error: "steps musi być tablicą" });

  try {
    const output = await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const { timeoutMs, waitUntil } = await preparePage(page, options);

      await page.goto(url, { waitUntil, timeout: timeoutMs });

      const evalResults = [];

      for (const step of steps) {
        const a = step?.action;
        if (!a) continue;

        switch (a) {
          case "waitForSelector":
            await page.waitForSelector(step.selector, {
              timeout: step.timeoutMs ?? timeoutMs,
            });
            break;

          case "click":
            await page.click(step.selector);
            break;

          case "type":
            await page.type(step.selector, step.text ?? "", {
              delay: step.delay ?? 0,
            });
            break;

          case "press":
            await page.keyboard.press(step.key);
            break;

          case "waitForTimeout":
            await page.waitForTimeout(step.ms ?? 0);
            break;

          case "waitForNavigation":
            await page.waitForNavigation({
              waitUntil: step.waitUntil ?? waitUntil,
              timeout: step.timeoutMs ?? timeoutMs,
            });
            break;

          case "evaluate":
            if (typeof step.fn !== "string") {
              throw new Error("evaluate.fn musi być stringiem");
            }
            {
              const r = await page.evaluate(new Function(step.fn));
              evalResults.push(r);
            }
            break;

          default:
            throw new Error(`Nieznana akcja: ${a}`);
        }
      }

      const finalUrl = page.url();
      const title = await page.title();

      const resp = { ok: true, finalUrl, title };

      if (result?.content) {
        resp.content = await page.content();
      }

      if (result?.screenshot?.enabled) {
        const s = result.screenshot;
        const buf = await page.screenshot({
          fullPage: s.fullPage ?? true,
          type: s.type === "jpeg" ? "jpeg" : "png",
          quality: s.type === "jpeg" ? (s.quality ?? 80) : undefined,
        });
        resp.screenshotBase64 = buf.toString("base64");
        resp.screenshotMime = s.type === "jpeg" ? "image/jpeg" : "image/png";
      }

      if (evalResults.length) resp.evalResults = evalResults;

      return resp;
    });

    res.json(output);
  } catch (e) {
    res.status(500).json({ error: "Błąd run", details: String(e) });
  }
});

app.listen(3000, () => {
  console.log("puppeteer-api listening on :3000");
});
