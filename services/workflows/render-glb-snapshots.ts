import fs from "fs/promises";
import path from "path";
import debug from "debug";
import sharp from "sharp";
import { chromium } from "playwright";
import type { Browser } from "playwright";

const log = debug("glb-rdr");

export type GlbBinary = Buffer | Uint8Array | ArrayBuffer;

export type RenderGlbSnapshotsOptions = {
  /** attributes in radians */
  views?: { polar: number; azimuth: number }[];
  size?: number; // square output size, default 1024
  background?: string; // CSS color
  format?: "image/png" | "image/jpeg"; // default "image/png"
  jpegQuality?: number; // 0..1, default 0.92
  timeoutMs?: number; // overall timeout for page ops, default 10000
};

export type ImageGridOptions = {
  background?: string; // used for padding & empty cells, default #000000
  format?: "image/png" | "image/jpeg"; // default "image/png"
  jpegQuality?: number; // 0..1, default 0.92
};

/** convert degrees to radians */
export function deg(deg: number) {
  return (deg * Math.PI) / 180;
}

async function createRendererBrowserContext() {
  const initializationTimeoutMs = 10_000;
  const workerPath = path.resolve(__dirname, "./workers/glb-render.html");
  const html = await fs.readFile(workerPath, "utf-8");

  const browser: Browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=swiftshader",
      "--disable-web-security",
      "--disable-logging",
      "--log-level=3",
      "--silent",
    ],
    logger: { isEnabled: () => false, log: () => {} },
  });

  const context = await browser.newContext({
    viewport: { width: 2048, height: 2048 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // Debug hooks
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e));
  page.on("console", (m) => log(`PAGE LOG [${m.type()}]: ${m.text()}`));
  page.on("requestfailed", (r) =>
    log("REQUEST FAILED:", r.url(), r.failure()?.errorText)
  );

  await page.setContent(html, { waitUntil: "load" });

  // wait until module script sets __API_READY
  await page.waitForFunction(() => (window as any).__API_READY === true, null, {
    timeout: initializationTimeoutMs,
  });

  return { browser, context, page };
}

function createLazyRendererBrowserContext() {
  type GlbRendererBrowserContext = ReturnType<
    typeof createRendererBrowserContext
  >;
  let contextPromise: GlbRendererBrowserContext | null =
    null as GlbRendererBrowserContext | null;
  const cleanup = () => lazyContext.destroy();

  process.on("SIGINT", cleanup);

  const lazyContext = {
    getInitializationPromise() {
      return contextPromise;
    },
    async ensureInitialized() {
      if (!contextPromise) contextPromise = createRendererBrowserContext();

      return contextPromise;
    },
    async destroy() {
      if (!contextPromise) return;
      const { page, context, browser } = await contextPromise;
      try {
        await page.close();
        await context.close();
      } finally {
        try {
          log("SIGINT: closing browser");
          await browser.close();
        } catch (e) {
          log("SIGINT: failed to close browser:", e);
        } finally {
          process.off("SIGINT", cleanup);
        }
      }
    },
  };

  return lazyContext;
}

function toBuffer(b: GlbBinary): Buffer {
  return b instanceof ArrayBuffer
    ? Buffer.from(b)
    : Buffer.isBuffer(b)
    ? b
    : Buffer.from(b);
}

function pickBestGrid(n: number, cellW: number, cellH: number) {
  let best = {
    cols: 1,
    rows: n,
    ratio: Number.POSITIVE_INFINITY,
    empty: 0,
    area: 0,
  };

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const gridW = cols * cellW;
    const gridH = rows * cellH;

    const ratio = gridW >= gridH ? gridW / gridH : gridH / gridW;
    const empty = rows * cols - n;
    const area = gridW * gridH;

    const better =
      ratio < best.ratio ||
      (ratio === best.ratio && empty < best.empty) ||
      (ratio === best.ratio && empty === best.empty && area < best.area) ||
      // final tie-break: prefer more columns (landscape)
      (ratio === best.ratio &&
        empty === best.empty &&
        area === best.area &&
        cols > best.cols);

    if (better) best = { cols, rows, ratio, empty, area };
  }

  return best;
}

/** Multi views -> single grid view (left->right, top->bottom), best layout by min aspect ratio. */
export async function createImageGrid(
  views: Array<GlbBinary>,
  options: ImageGridOptions = {}
): Promise<Buffer> {
  const {
    background = "#000000",
    format = "image/png",
    jpegQuality = 0.92,
  } = options;

  if (!views.length) throw new Error("views is empty");

  const bufs = views.map(toBuffer);

  const metas = await Promise.all(bufs.map((b) => sharp(b).metadata()));
  const cellW = Math.max(...metas.map((m) => m.width ?? 0));
  const cellH = Math.max(...metas.map((m) => m.height ?? 0));
  if (!cellW || !cellH) throw new Error("failed to read image width/height");

  const { cols, rows } = pickBestGrid(bufs.length, cellW, cellH);
  const outW = cols * cellW;
  const outH = rows * cellH;

  const resized = await Promise.all(
    bufs.map((b) =>
      sharp(b).resize(cellW, cellH, { fit: "contain", background }).toBuffer()
    )
  );

  const composites = resized.map((input, i) => ({
    input,
    left: (i % cols) * cellW,
    top: Math.floor(i / cols) * cellH,
  }));

  let img = sharp({
    create: { width: outW, height: outH, channels: 4, background },
  }).composite(composites);

  if (format === "image/jpeg") {
    img = img.jpeg({
      quality: Math.round(Math.max(0, Math.min(1, jpegQuality)) * 100),
      mozjpeg: true,
    });
  } else {
    img = img.png();
  }

  return await img.toBuffer();
}

export class GlbSnapshotsRenderer {
  readonly lazyContext = createLazyRendererBrowserContext();

  constructor() {}

  async renderGlbSnapshots(
    glbBinary: GlbBinary,
    options: RenderGlbSnapshotsOptions = {}
  ) {
    const contextPromise = this.lazyContext.ensureInitialized();
    const {
      views = [],
      size = 512,
      background = "#000000",
      format = "image/png",
      jpegQuality = 0.92,
      timeoutMs = 10_000,
    } = options;

    if (!views.length) {
      const helix1: typeof views = [];
      const helix2: typeof views = [];
      const N = 16;
      const M = N / 2; // 8 points per helix
      const turns = 1; // 繞幾圈：1 或 2 常用

      for (let i = 0; i < M; i++) {
        // Helix A: from top (north pole) downward, includes polar=0, excludes polar=180
        const tA = i / M; // 0, 1/8, ..., 7/8
        const zA = 1 - 2 * tA; // 1 -> -0.75
        const polarA = (Math.acos(zA) * 180) / Math.PI;
        const azA = (turns * 360 * tA) % 360;

        helix1.push({ polar: deg(polarA), azimuth: deg(azA) });

        // Helix B: from bottom (south pole) upward, includes polar=180, excludes polar=0
        const tB = 1 - i / M; // 1, 7/8, ..., 1/8
        const zB = 1 - 2 * tB; // -1 -> 0.75
        const polarB = (Math.acos(zB) * 180) / Math.PI;

        // phase shift 180° to make it a true double-helix (avoid overlap)
        const azB = (turns * 360 * tB + 180) % 360;

        helix2.push({ polar: deg(polarB), azimuth: deg(azB) });
      }
      views.push(...helix1, ...helix2);
    }

    const glbBuffer = toBuffer(glbBinary);
    const glbBase64 = glbBuffer.toString("base64");

    const dataUrls = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout"));
      }, timeoutMs);
      contextPromise
        .then(({ page }) =>
          page.evaluate(
            ({ glbBase64, views, size, background, format, jpegQuality }) =>
              // @ts-ignore inner function
              window.__RENDER_GLB_VIEWS(glbBase64, {
                views,
                size,
                background,
                format,
                jpegQuality,
              }),
            { glbBase64, views, size, background, format, jpegQuality }
          )
        )
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timeout));
    });

    if (
      !(Array.isArray(dataUrls) && dataUrls.every((i) => typeof i === "string"))
    ) {
      throw new Error("Invalid output");
    }

    const buffers = dataUrls.map((u) => {
      const idx = u.indexOf(",");
      const b64 = idx >= 0 ? u.slice(idx + 1) : u;
      return Buffer.from(b64, "base64");
    });

    return buffers;
  }

  async renderGlbSnapshotsToGrid(
    glbBinary: GlbBinary,
    options: RenderGlbSnapshotsOptions = {},
    gridOptions: ImageGridOptions = {}
  ) {
    const views = await this.renderGlbSnapshots(glbBinary, options);
    const grid = await createImageGrid(views, gridOptions);
    return grid;
  }

  async destroy() {
    await this.lazyContext.destroy();
  }
}
