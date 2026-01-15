// test/workflows/object-designer.test.ts
import path from "path";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import { generateGlbFromCode } from "../../src/services/workflows/generate-glb-from-code";
import { extractCodeFromMarkdown } from "../../src/services/workflows/generate-code";

describe("workflows/object-designer", () => {
  it("extracts code from teapot.md and exports GLTF to output file", async () => {
    jest.setTimeout(10_000);

    const fixturePath = path.resolve(
      process.cwd(),
      "test",
      "workflows",
      "fixtures",
      "teapot.md"
    );

    const md = await readFile(fixturePath, "utf8");
    const code = extractCodeFromMarkdown(md) ?? md;

    expect(typeof code).toBe("string");
    expect(code.trim().length).toBeGreaterThan(0);

    const glb = await generateGlbFromCode({ code });
    expect(glb).toBeTruthy();
    expect(typeof glb).toBe("object");

    const outDir = path.resolve(
      process.cwd(),
      "public",
      "output",
      "workflows",
      "object-designer"
    );
    const outFile = path.join(outDir, "teapot.glb");

    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, glb, "utf8");

    const fileStat = await stat(outFile);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.size).toBeGreaterThan(0);
  });
});
