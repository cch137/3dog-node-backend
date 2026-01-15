// test/workflows/render-glb-snapshots.test.ts
import path from "path";
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import sharp from "sharp";
import {
  GlbSnapshotsRenderer,
  createImageGrid,
  deg,
} from "../../services/workflows/render-glb-snapshots";

describe("workflows/render-glb-snapshots", () => {
  jest.setTimeout(10_000);

  const fixturePath = path.resolve(
    process.cwd(),
    "test",
    "workflows",
    "fixtures",
    "teapot.glb"
  );

  const outDir = path.resolve(
    process.cwd(),
    "public",
    "output",
    "workflows",
    "render-glb-snapshots"
  );

  let glb: Buffer;
  let renderer: GlbSnapshotsRenderer;

  beforeAll(async () => {
    glb = await readFile(fixturePath);
    renderer = new GlbSnapshotsRenderer();
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
  });

  afterAll(async () => {
    await renderer.destroy();
  });

  it("renders default 16 PNG snapshots and writes them to public/output for preview", async () => {
    const views = await renderer.renderGlbSnapshots(glb, {
      size: 256,
      background: "#000000",
      format: "image/png",
      timeoutMs: 60_000,
    });

    expect(views).toHaveLength(16);

    for (let i = 0; i < views.length; i++) {
      const buf = views[i];
      const file = path.join(
        outDir,
        `default-view-${String(i).padStart(2, "0")}.png`
      );

      await writeFile(file, buf);

      const st = await stat(file);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBeGreaterThan(0);

      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(256);
      expect(meta.height).toBe(256);
    }

    const grid = await createImageGrid(views, {
      background: "#000000",
      format: "image/png",
    });

    const gridFile = path.join(outDir, "default-grid.png");
    await writeFile(gridFile, grid);

    const gridStat = await stat(gridFile);
    expect(gridStat.isFile()).toBe(true);
    expect(gridStat.size).toBeGreaterThan(0);

    const gridMeta = await sharp(grid).metadata();
    expect(gridMeta.format).toBe("png");
    expect(gridMeta.width).toBe(256 * 4);
    expect(gridMeta.height).toBe(256 * 4);
  });

  it("renders custom JPEG snapshots + grid and writes them to public/output for preview", async () => {
    const views = await renderer.renderGlbSnapshots(glb, {
      views: [
        { polar: deg(45), azimuth: deg(0) },
        { polar: deg(45), azimuth: deg(90) },
        { polar: deg(45), azimuth: deg(180) },
        { polar: deg(45), azimuth: deg(270) },
      ],
      size: 320,
      background: "#ffffff",
      format: "image/jpeg",
      jpegQuality: 0.85,
      timeoutMs: 60_000,
    });

    expect(views).toHaveLength(4);

    for (let i = 0; i < views.length; i++) {
      const buf = views[i];
      const file = path.join(
        outDir,
        `jpeg-view-${String(i).padStart(2, "0")}.jpg`
      );

      await writeFile(file, buf);

      const st = await stat(file);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBeGreaterThan(0);

      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(320);
      expect(meta.height).toBe(320);
    }

    const grid = await createImageGrid(views, {
      background: "#ffffff",
      format: "image/jpeg",
      jpegQuality: 0.85,
    });

    const gridFile = path.join(outDir, "jpeg-grid.jpg");
    await writeFile(gridFile, grid);

    const gridStat = await stat(gridFile);
    expect(gridStat.isFile()).toBe(true);
    expect(gridStat.size).toBeGreaterThan(0);

    const gridMeta = await sharp(grid).metadata();
    expect(gridMeta.format).toBe("jpeg");
    expect(gridMeta.width).toBe(320 * 2);
    expect(gridMeta.height).toBe(320 * 2);
  });
});
