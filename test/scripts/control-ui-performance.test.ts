import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectControlUiPerformanceMetrics,
  evaluateControlUiPerformanceBudgets,
  extractControlUiStartupAssetPaths,
  formatControlUiPerformanceReport,
} from "../../scripts/check-control-ui-performance.mjs";

const tempDirs: string[] = [];

function createDistFixture() {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-performance-"));
  const assetsDir = path.join(distDir, "assets");
  fs.mkdirSync(assetsDir);
  tempDirs.push(distDir);
  const writeAsset = (
    file: string,
    sizes: { rawBytes: number; gzipBytes: number; brotliBytes: number },
  ) => {
    const assetPath = path.join(assetsDir, file);
    fs.writeFileSync(assetPath, Buffer.alloc(sizes.rawBytes));
    fs.writeFileSync(`${assetPath}.gz`, Buffer.alloc(sizes.gzipBytes));
    fs.writeFileSync(`${assetPath}.br`, Buffer.alloc(sizes.brotliBytes));
  };
  return { distDir, writeAsset };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("Control UI performance budgets", () => {
  it("extracts startup assets across relative and base-prefixed URLs", () => {
    expect(
      extractControlUiStartupAssetPaths(`
        <script type="module" src="./assets/index-abc.js?build=1"></script>
        <link rel="modulepreload" href="/control/assets/runtime-def.js">
        <link rel="stylesheet" href="./assets/index-abc.css#theme">
        <script data-src="./assets/deferred.js"></script>
        <link rel="manifest" href="./manifest.webmanifest">
      `),
    ).toEqual(["assets/index-abc.css", "assets/index-abc.js", "assets/runtime-def.js"]);
  });

  it("reports startup, total, and largest compressed assets", () => {
    const { distDir, writeAsset } = createDistFixture();
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="./assets/index-a.js"></script>\n' +
        '<link rel="modulepreload" href="./assets/runtime-b.js">\n' +
        '<link rel="stylesheet" href="./assets/index-c.css">\n',
    );
    writeAsset("index-a.js", { rawBytes: 100, gzipBytes: 40, brotliBytes: 30 });
    writeAsset("runtime-b.js", { rawBytes: 80, gzipBytes: 25, brotliBytes: 20 });
    writeAsset("lazy-d.js", { rawBytes: 200, gzipBytes: 70, brotliBytes: 55 });
    writeAsset("index-c.css", { rawBytes: 50, gzipBytes: 15, brotliBytes: 12 });

    const metrics = collectControlUiPerformanceMetrics(distDir);

    expect(metrics.startup.js).toEqual({
      requests: 2,
      rawBytes: 180,
      gzipBytes: 65,
      brotliBytes: 50,
    });
    expect(metrics.startup.css.gzipBytes).toBe(15);
    expect(metrics.total.js).toMatchObject({ requests: 3, rawBytes: 380, gzipBytes: 135 });
    expect(metrics.largest.js.file).toBe("assets/lazy-d.js");
    expect(metrics.largest.css.file).toBe("assets/index-c.css");
    expect(formatControlUiPerformanceReport(metrics)).toContain("startup CSS: 1 request");
  });

  it("returns actionable violations and includes them in the report", () => {
    const { distDir, writeAsset } = createDistFixture();
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="./assets/index-a.js"></script>\n' +
        '<link rel="stylesheet" href="./assets/index-c.css">\n',
    );
    writeAsset("index-a.js", { rawBytes: 100, gzipBytes: 40, brotliBytes: 30 });
    writeAsset("index-c.css", { rawBytes: 50, gzipBytes: 15, brotliBytes: 12 });
    const metrics = collectControlUiPerformanceMetrics(distDir);
    const budgets = {
      startupJsRequests: 0,
      startupCssRequests: 1,
      startupJsGzipBytes: 30,
      startupCssGzipBytes: 20,
      largestJsGzipBytes: 35,
      largestCssGzipBytes: 20,
    };

    expect(
      evaluateControlUiPerformanceBudgets(metrics, budgets).map((entry) => entry.metric),
    ).toEqual(["startup JS requests", "startup JS gzip", "largest JS gzip"]);
    expect(formatControlUiPerformanceReport(metrics, budgets)).toContain(
      "startup JS gzip: 40 B exceeds 30 B",
    );
  });

  it("fails when a compressed sidecar is missing", () => {
    const { distDir } = createDistFixture();
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="./assets/index-a.js"></script>\n',
    );
    fs.writeFileSync(path.join(distDir, "assets/index-a.js"), "source");

    expect(() => collectControlUiPerformanceMetrics(distDir)).toThrow("missing index-a.js.gz");
  });
});
