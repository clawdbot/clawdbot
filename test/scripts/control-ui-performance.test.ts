import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_UI_PERFORMANCE_BUDGETS,
  collectControlUiPerformanceMetrics,
  evaluateControlUiPerformanceBudgets,
  extractControlUiStartupAssetPaths,
  formatControlUiPerformanceReport,
  runControlUiPerformanceCheck,
} from "../../scripts/check-control-ui-performance.mts";

const tempDirs: string[] = [];
const tsxImport = import.meta.resolve("tsx");

function runControlUiPerformanceCli(scriptPath: string, args: string[], cwd: string) {
  return spawnSync(
    process.execPath,
    ["--import", tsxImport, fs.realpathSync(scriptPath), ...args],
    { cwd, encoding: "utf8" },
  );
}

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

function createMetrics(startupJsGzipBytes: number) {
  return {
    schemaVersion: 1 as const,
    startup: {
      js: { requests: 1, rawBytes: 2_000, gzipBytes: startupJsGzipBytes, brotliBytes: 900 },
      css: { requests: 1, rawBytes: 50, gzipBytes: 15, brotliBytes: 12 },
      assets: [],
    },
    total: {
      js: { requests: 1, rawBytes: 2_000, gzipBytes: startupJsGzipBytes, brotliBytes: 900 },
      css: { requests: 1, rawBytes: 50, gzipBytes: 15, brotliBytes: 12 },
    },
    largest: {
      js: {
        file: "assets/index-a.js",
        type: "js" as const,
        rawBytes: 2_000,
        gzipBytes: startupJsGzipBytes,
        brotliBytes: 900,
      },
      css: {
        file: "assets/index-c.css",
        type: "css" as const,
        rawBytes: 50,
        gzipBytes: 15,
        brotliBytes: 12,
      },
    },
  };
}

const looseBudgets = {
  startupJsRequests: 10,
  startupCssRequests: 10,
  startupJsGzipBytes: 100_000,
  startupCssGzipBytes: 100_000,
  largestJsGzipBytes: 100_000,
  largestCssGzipBytes: 100_000,
};

function startupBaseline(startupJsGzipBytes: number) {
  return {
    startupJsGzipBytes,
    reason: "test baseline",
    updatedAt: "2026-07-22",
  };
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

  it("includes exact bytes when rounded violation values collide", () => {
    const metrics = {
      schemaVersion: 1 as const,
      startup: {
        js: { requests: 1, rawBytes: 100, gzipBytes: 43_009, brotliBytes: 30 },
        css: { requests: 1, rawBytes: 50, gzipBytes: 15, brotliBytes: 12 },
        assets: [],
      },
      total: {
        js: { requests: 1, rawBytes: 100, gzipBytes: 43_009, brotliBytes: 30 },
        css: { requests: 1, rawBytes: 50, gzipBytes: 15, brotliBytes: 12 },
      },
      largest: {
        js: {
          file: "assets/index-a.js",
          type: "js",
          rawBytes: 100,
          gzipBytes: 43_009,
          brotliBytes: 30,
        },
        css: {
          file: "assets/index-c.css",
          type: "css",
          rawBytes: 50,
          gzipBytes: 15,
          brotliBytes: 12,
        },
      },
    } satisfies ReturnType<typeof collectControlUiPerformanceMetrics>;
    const budgets = {
      startupJsRequests: 1,
      startupCssRequests: 1,
      startupJsGzipBytes: 43_008,
      startupCssGzipBytes: 20,
      largestJsGzipBytes: 43_008,
      largestCssGzipBytes: 20,
    };

    expect(formatControlUiPerformanceReport(metrics, budgets)).toContain(
      "startup JS gzip: 42.0 KiB exceeds 42.0 KiB (43009 B vs 43008 B)",
    );
  });

  it("allows CI-measured startup JS growth within the ratchet tolerance", () => {
    const violations = evaluateControlUiPerformanceBudgets(
      createMetrics(326_672),
      { ...looseBudgets, startupJsGzipBytes: 319 * 1024, largestJsGzipBytes: 400_000 },
      startupBaseline(325_675),
    );

    expect(violations).toEqual([]);
  });

  it("fails startup JS growth over the ratchet tolerance with update guidance", () => {
    const metrics = createMetrics(326_700);
    const baseline = startupBaseline(325_675);
    const budgets = {
      ...looseBudgets,
      startupJsGzipBytes: 319 * 1024,
      largestJsGzipBytes: 400_000,
    };

    expect(
      evaluateControlUiPerformanceBudgets(metrics, budgets, baseline).map((entry) => entry.metric),
    ).toContain("startup JS gzip");
    expect(formatControlUiPerformanceReport(metrics, budgets, baseline)).toContain(
      "startup JS gzip: 319.0 KiB exceeds 319.0 KiB (326700 B vs 326699 B)",
    );
    expect(formatControlUiPerformanceReport(metrics, budgets, baseline)).toContain(
      "limits: 10 requests, 319.0 KiB gzip",
    );
  });

  it("rejects committed startup JS baselines above the fixed cap", () => {
    const budgets = {
      ...looseBudgets,
      startupJsGzipBytes: 319 * 1024,
      largestJsGzipBytes: 400_000,
    };

    expect(
      evaluateControlUiPerformanceBudgets(
        createMetrics(319 * 1024),
        budgets,
        startupBaseline(319 * 1024 + 1),
      ).map((entry) => entry.metric),
    ).toEqual(["startup JS gzip baseline"]);
  });

  it("rejects startup JS measurements above the cap plus tolerance", () => {
    const budgets = {
      ...looseBudgets,
      startupJsGzipBytes: 319 * 1024,
      largestJsGzipBytes: 400_000,
    };

    expect(
      evaluateControlUiPerformanceBudgets(
        createMetrics(320 * 1024 + 1),
        budgets,
        startupBaseline(319 * 1024),
      ).map((entry) => entry.metric),
    ).toEqual(["startup JS gzip"]);
  });

  it("suggests lowering a baseline after a meaningful size reduction", () => {
    expect(
      formatControlUiPerformanceReport(
        createMetrics(10_000),
        looseBudgets,
        startupBaseline(14_097),
      ),
    ).toContain("hint: startup JS gzip is more than 4096 B below the 14097 B baseline");
  });

  it("fails closed when the startup baseline is malformed", () => {
    const { distDir, writeAsset } = createDistFixture();
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="./assets/index-a.js"></script>\n' +
        '<link rel="stylesheet" href="./assets/index-c.css">\n',
    );
    writeAsset("index-a.js", { rawBytes: 100, gzipBytes: 40, brotliBytes: 30 });
    writeAsset("index-c.css", { rawBytes: 50, gzipBytes: 15, brotliBytes: 12 });
    const baselinePath = path.join(distDir, "baseline.json");
    fs.writeFileSync(baselinePath, '{"startupJsGzipBytes":"not-a-number"}\n');

    expect(() => runControlUiPerformanceCheck(distDir, looseBudgets, baselinePath)).toThrow(
      /Cannot read Control UI startup budget baseline .*--update-baseline/u,
    );
  });

  it("fails closed when the startup baseline exceeds the configured cap", () => {
    const { distDir, writeAsset } = createDistFixture();
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="./assets/index-a.js"></script>\n' +
        '<link rel="stylesheet" href="./assets/index-c.css">\n',
    );
    writeAsset("index-a.js", { rawBytes: 100, gzipBytes: 40, brotliBytes: 30 });
    writeAsset("index-c.css", { rawBytes: 50, gzipBytes: 15, brotliBytes: 12 });
    const baselinePath = path.join(distDir, "baseline.json");
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({
        startupJsGzipBytes: CONTROL_UI_PERFORMANCE_BUDGETS.startupJsGzipBytes + 1,
        reason: "invalid test baseline",
        updatedAt: "2026-08-11",
      }),
    );

    expect(() => runControlUiPerformanceCheck(distDir, undefined, baselinePath)).toThrow(
      new RegExp(
        `startupJsGzipBytes at most ${CONTROL_UI_PERFORMANCE_BUDGETS.startupJsGzipBytes}`,
        "u",
      ),
    );
  });

  it("updates the baseline from local or explicit CI metrics", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-budget-cli-"));
    tempDirs.push(rootDir);
    const scriptsDir = path.join(rootDir, "scripts");
    const configDir = path.join(rootDir, "config");
    const distDir = path.join(rootDir, "dist/control-ui");
    const assetsDir = path.join(distDir, "assets");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, "check-control-ui-performance.mts");
    fs.copyFileSync(path.resolve("scripts/check-control-ui-performance.mts"), scriptPath);
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="./assets/index-a.js"></script>\n' +
        '<link rel="stylesheet" href="./assets/index-c.css">\n',
    );
    for (const [file, sizes] of [
      ["index-a.js", { rawBytes: 100, gzipBytes: 65, brotliBytes: 50 }],
      ["index-c.css", { rawBytes: 50, gzipBytes: 15, brotliBytes: 12 }],
    ] as const) {
      const assetPath = path.join(assetsDir, file);
      fs.writeFileSync(assetPath, Buffer.alloc(sizes.rawBytes));
      fs.writeFileSync(`${assetPath}.gz`, Buffer.alloc(sizes.gzipBytes));
      fs.writeFileSync(`${assetPath}.br`, Buffer.alloc(sizes.brotliBytes));
    }

    const result = runControlUiPerformanceCli(scriptPath, ["--update-baseline"], rootDir);

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(configDir, "control-ui-startup-budget-baseline.json"), "utf8"),
      ),
    ).toEqual({
      startupJsGzipBytes: 65,
      reason: "manual baseline update",
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
    });

    const customReasonResult = runControlUiPerformanceCli(
      scriptPath,
      ["--update-baseline", "--reason", "fixture update"],
      rootDir,
    );
    expect(customReasonResult.status, customReasonResult.stderr).toBe(0);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(configDir, "control-ui-startup-budget-baseline.json"), "utf8"),
      ),
    ).toMatchObject({ startupJsGzipBytes: 65, reason: "fixture update" });

    fs.rmSync(distDir, { recursive: true });
    const explicitBytesResult = runControlUiPerformanceCli(
      scriptPath,
      ["--update-baseline", "--startup-js-bytes", "321", "--reason", "CI measurement"],
      rootDir,
    );
    expect(explicitBytesResult.status, explicitBytesResult.stderr).toBe(0);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(configDir, "control-ui-startup-budget-baseline.json"), "utf8"),
      ),
    ).toMatchObject({ startupJsGzipBytes: 321, reason: "CI measurement" });

    const beyondRatchetResult = runControlUiPerformanceCli(
      scriptPath,
      ["--update-baseline", "--startup-js-bytes", "4418"],
      rootDir,
    );
    expect(beyondRatchetResult.status).toBe(1);
    expect(beyondRatchetResult.stderr).toContain(
      "4418 B differs from current baseline 321 B by 4097 B, exceeding the 4096 B ratchet",
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(configDir, "control-ui-startup-budget-baseline.json"), "utf8"),
      ),
    ).toMatchObject({ startupJsGzipBytes: 321, reason: "CI measurement" });
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
