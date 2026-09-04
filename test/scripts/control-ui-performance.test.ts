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
const tsxImport = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const baselineUpdateCommand =
  'node --import ./scripts/tsx.mjs scripts/check-control-ui-performance.mts --update-baseline --reason "<reason>"';

function runControlUiPerformanceCli(scriptPath: string, args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.TSX_DISABLE_CACHE;
  return spawnSync(
    process.execPath,
    ["--import", tsxImport, fs.realpathSync(scriptPath), ...args],
    { cwd, env, encoding: "utf8", timeout: 10_000 },
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

function createCliFixture(startupCssGzipBytes = 15, deferredCssGzipBytes = 15) {
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
    path.join(scriptsDir, "tsx.mjs"),
    `await import(${JSON.stringify(tsxImport)});\n`,
  );
  fs.writeFileSync(
    path.join(distDir, "index.html"),
    '<script type="module" src="./assets/index-a.js"></script>\n' +
      '<link rel="stylesheet" href="./assets/index-c.css">\n',
  );
  for (const [file, sizes] of [
    ["index-a.js", { rawBytes: 100, gzipBytes: 65, brotliBytes: 50 }],
    ["index-c.css", { rawBytes: 50, gzipBytes: startupCssGzipBytes, brotliBytes: 12 }],
    ["lazy-d.css", { rawBytes: 50, gzipBytes: deferredCssGzipBytes, brotliBytes: 12 }],
  ] as const) {
    const assetPath = path.join(assetsDir, file);
    fs.writeFileSync(assetPath, Buffer.alloc(sizes.rawBytes));
    fs.writeFileSync(`${assetPath}.gz`, Buffer.alloc(sizes.gzipBytes));
    fs.writeFileSync(`${assetPath}.br`, Buffer.alloc(sizes.brotliBytes));
  }
  fs.writeFileSync(
    path.join(configDir, "control-ui-startup-budget-baseline.json"),
    JSON.stringify(startupBaseline(65)),
  );
  return { rootDir, scriptPath, configDir, distDir };
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
    mermaidRenderer: [],
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

  it.each([
    { name: "accepts the capped deferred renderer", gzipBytes: 960 * 1024, violations: [] },
    {
      name: "rejects renderer growth above its cap",
      gzipBytes: 960 * 1024 + 1,
      violations: ["isolated Mermaid JS gzip"],
    },
    {
      name: "rejects duplicate renderer artifacts",
      gzipBytes: 200_000,
      duplicate: true,
      violations: ["isolated Mermaid JS assets"],
    },
    {
      name: "rejects the renderer in startup preloads",
      gzipBytes: 200_000,
      startup: true,
      violations: ["startup Mermaid JS assets"],
    },
    {
      name: "retains the ordinary chunk cap beside the renderer",
      gzipBytes: 200_000,
      ordinaryGzipBytes: 215 * 1024 + 1,
      violations: ["largest JS gzip"],
    },
    {
      name: "does not exempt similarly named chunks",
      gzipBytes: 960 * 1024,
      rendererName: "mermaid-extra-a.js",
      violations: ["largest JS gzip"],
    },
  ])("$name", ({ gzipBytes, duplicate, startup, ordinaryGzipBytes, rendererName, violations }) => {
    const { distDir, writeAsset } = createDistFixture();
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="./assets/index-a.js"></script>\n' +
        '<link rel="stylesheet" href="./assets/index-c.css">\n' +
        (startup ? '<link rel="modulepreload" href="./assets/mermaid.min-a.js">\n' : ""),
    );
    writeAsset("index-a.js", { rawBytes: 100, gzipBytes: 40, brotliBytes: 30 });
    writeAsset("lazy-b.js", {
      rawBytes: 200,
      gzipBytes: ordinaryGzipBytes ?? 70,
      brotliBytes: 55,
    });
    writeAsset("index-c.css", { rawBytes: 50, gzipBytes: 15, brotliBytes: 12 });
    writeAsset(rendererName ?? "mermaid.min-a.js", { rawBytes: 200, gzipBytes, brotliBytes: 100 });
    if (duplicate) {
      writeAsset("mermaid.min-b.js", { rawBytes: 200, gzipBytes, brotliBytes: 100 });
    }

    const metrics = collectControlUiPerformanceMetrics(distDir);
    expect(evaluateControlUiPerformanceBudgets(metrics).map((entry) => entry.metric)).toEqual(
      violations,
    );
    expect(metrics.total.js.gzipBytes).toBe(
      40 + (ordinaryGzipBytes ?? 70) + gzipBytes * (duplicate ? 2 : 1),
    );
    if (!rendererName) {
      expect(metrics.largest.js.file).toBe("assets/lazy-b.js");
      expect(formatControlUiPerformanceReport(metrics)).toContain("isolated Mermaid JS:");
    }
  });

  it("includes exact bytes when rounded violation values collide", () => {
    const metrics = createMetrics(43_009);
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

  it.each([
    ["accepts startup CSS exactly at 45 KiB", 45 * 1024, 0],
    ["rejects startup CSS one byte above 45 KiB", 45 * 1024 + 1, 1],
  ])("%s", (_name, startupCssGzipBytes, expectedStatus) => {
    const { rootDir, scriptPath } = createCliFixture(startupCssGzipBytes);
    const result = runControlUiPerformanceCli(scriptPath, ["--json"], rootDir);

    expect(result.status, result.stderr).toBe(expectedStatus);
    const report = JSON.parse(result.stdout);
    expect(report.violations).toEqual(
      expectedStatus
        ? [
            expect.objectContaining({
              metric: "startup CSS gzip",
              actual: 45 * 1024 + 1,
              limit: 45 * 1024,
            }),
          ]
        : [],
    );
    expect(report.report).toContain(`hard ceiling ${45 * 1024} B`);
  });

  it.each<
    [
      name: string,
      css: number,
      baseCss: number,
      lazy: number,
      baseLazy: number,
      metric: string | null,
    ]
  >([
    ["startup growth below 1 KiB", 45_000, 43_977, 45_000, 45_000, null],
    ["startup growth at 1 KiB", 45_000, 43_976, 45_000, 45_000, "startup CSS"],
    ["deferred growth below 1 KiB", 45_000, 45_000, 52_000, 50_977, null],
    ["deferred growth at 1 KiB", 45_000, 45_000, 52_000, 50_976, "largest CSS"],
    ["deferred at the hard cap", 45_000, 45_000, 53_400, 53_400, null],
    ["deferred above the hard cap", 45_000, 45_000, 53_401, 53_401, "largest CSS"],
  ])("checks %s against built base assets", (_name, css, baseCss, lazy, baseLazy, metric) => {
    const current = createCliFixture(css, lazy);
    const base = createCliFixture(baseCss, baseLazy);
    const result = runControlUiPerformanceCli(
      current.scriptPath,
      ["--json", "--base-dist", base.distDir],
      current.rootDir,
    );

    expect(result.status, result.stderr).toBe(metric ? 1 : 0);
    const report = JSON.parse(result.stdout);
    expect(report.baseMetrics.startup.css.gzipBytes).toBe(baseCss);
    expect(report.baseMetrics.largest.css.gzipBytes).toBe(Math.max(baseCss, baseLazy));
    expect(report.violations).toEqual(
      metric ? [expect.objectContaining({ metric: expect.stringContaining(metric) })] : [],
    );
    expect(report.report).toContain(`${css} B`);
  });

  it("keeps budget violations visible in report-only mode without rejecting artifacts", () => {
    const { rootDir, scriptPath } = createCliFixture(46_081);
    const enforced = runControlUiPerformanceCli(scriptPath, ["--json"], rootDir);
    const reported = runControlUiPerformanceCli(scriptPath, ["--json", "--report-only"], rootDir);

    expect(enforced.status, enforced.stderr).toBe(1);
    expect(reported.status, reported.stderr).toBe(0);
    const report = JSON.parse(reported.stdout);
    expect(report.violations).toEqual(JSON.parse(enforced.stdout).violations);
    expect(report.violations).toEqual([
      expect.objectContaining({ metric: "startup CSS gzip", actual: 46_081, limit: 46_080 }),
    ]);
  });

  it.each(["missing baseline", "malformed baseline", "missing sidecar", "missing base dist"])(
    "still rejects a %s in report-only mode",
    (invalid) => {
      const { rootDir, scriptPath, configDir, distDir } = createCliFixture();
      const args = ["--report-only"];
      if (invalid === "missing baseline") {
        fs.unlinkSync(path.join(configDir, "control-ui-startup-budget-baseline.json"));
      } else if (invalid === "malformed baseline") {
        fs.writeFileSync(path.join(configDir, "control-ui-startup-budget-baseline.json"), "{}");
      } else if (invalid === "missing sidecar") {
        fs.unlinkSync(path.join(distDir, "assets/index-c.css.gz"));
      } else {
        args.push("--base-dist", path.join(rootDir, "missing-base"));
      }

      const result = runControlUiPerformanceCli(scriptPath, args, rootDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /Cannot read Control UI startup budget baseline|missing index-c.css.gz|ENOENT/u,
      );
    },
  );

  it.each(["--report-only", "--base-dist"])(
    "rejects %s during baseline updates without changing the baseline",
    (option) => {
      const { rootDir, scriptPath, configDir, distDir } = createCliFixture();
      const baselinePath = path.join(configDir, "control-ui-startup-budget-baseline.json");
      const before = fs.readFileSync(baselinePath, "utf8");
      const args = ["--update-baseline", option];
      if (option === "--base-dist") {
        args.push(distDir);
      }

      const result = runControlUiPerformanceCli(scriptPath, args, rootDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--update-baseline");
      expect(fs.readFileSync(baselinePath, "utf8")).toBe(before);
    },
  );

  it("allows startup JS growth exactly at the ratchet tolerance", () => {
    const metrics = createMetrics(326_187);
    const baseline = startupBaseline(325_675);
    const budgets = {
      ...looseBudgets,
      startupJsGzipBytes: 319 * 1024,
      largestJsGzipBytes: 400_000,
    };
    const violations = evaluateControlUiPerformanceBudgets(metrics, budgets, baseline);

    expect(violations).toEqual([]);
    expect(formatControlUiPerformanceReport(metrics, budgets, baseline)).toContain(
      "growth allowance 512 B = growth limit 326187 B",
    );
  });

  it("allows startup JS at the growth plus build-variance boundary", () => {
    const metrics = createMetrics(326_251);
    const baseline = startupBaseline(325_675);
    const budgets = {
      ...looseBudgets,
      startupJsGzipBytes: 319 * 1024,
      largestJsGzipBytes: 400_000,
    };

    expect(evaluateControlUiPerformanceBudgets(metrics, budgets, baseline)).toEqual([]);
    expect(formatControlUiPerformanceReport(metrics, budgets, baseline)).toContain(
      "build-variance allowance 64 B; enforcement limit 326251 B",
    );
  });

  it("fails startup JS one byte beyond the growth plus build-variance boundary", () => {
    const metrics = createMetrics(326_252);
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
      "startup JS gzip: 318.6 KiB exceeds 318.6 KiB (326252 B vs 326251 B)",
    );
    expect(formatControlUiPerformanceReport(metrics, budgets, baseline)).toContain(
      "limits: 10 requests, 318.6 KiB gzip / 326251 B",
    );
  });

  it.each([343_426, 343_464])(
    "allows same-source startup JS observations within a 38 B spread (%i B)",
    (startupJsGzipBytes) => {
      const violations = evaluateControlUiPerformanceBudgets(
        createMetrics(startupJsGzipBytes),
        { ...looseBudgets, startupJsGzipBytes: 350 * 1024, largestJsGzipBytes: 400_000 },
        startupBaseline(342_930),
      );

      expect(violations).toEqual([]);
    },
  );

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

  it("rejects startup JS measurements above the cap plus growth and build variance", () => {
    const budgets = {
      ...looseBudgets,
      startupJsGzipBytes: 319 * 1024,
      largestJsGzipBytes: 400_000,
    };

    expect(
      evaluateControlUiPerformanceBudgets(
        createMetrics(319 * 1024 + 577),
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
    ).toContain(
      `hint: startup JS gzip is more than 4096 B below the 14097 B baseline; lower it with ${baselineUpdateCommand}`,
    );
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
    expect(() => runControlUiPerformanceCheck(distDir, looseBudgets, baselinePath)).toThrow(
      `Regenerate it with ${baselineUpdateCommand}.`,
    );
  });

  it("reports product growth and build variance as separate result fields", () => {
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
        startupJsGzipBytes: 40,
        reason: "test baseline",
        updatedAt: "2026-08-27",
      }),
    );

    expect(runControlUiPerformanceCheck(distDir, looseBudgets, baselinePath)).toMatchObject({
      startupJsTolerance: 512,
      startupJsBuildVariance: 64,
    });
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

  it("updates the baseline from generated or explicitly measured metrics", () => {
    const { rootDir, scriptPath, configDir, distDir } = createCliFixture();

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
      ["--update-baseline", "--startup-js-bytes", "321", "--reason", "explicit measurement"],
      rootDir,
    );
    expect(explicitBytesResult.status, explicitBytesResult.stderr).toBe(0);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(configDir, "control-ui-startup-budget-baseline.json"), "utf8"),
      ),
    ).toMatchObject({ startupJsGzipBytes: 321, reason: "explicit measurement" });

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
    ).toMatchObject({ startupJsGzipBytes: 321, reason: "explicit measurement" });
  });

  it.each([
    { name: "lowering", baseline: JSON.stringify(startupBaseline(5_000)), exitCode: 0 },
    { name: "malformed", baseline: '{"startupJsGzipBytes":"not-a-number"}\n', exitCode: 1 },
    { name: "missing", baseline: null, exitCode: 1 },
  ])("executes the $name baseline hint with the canonical preload", ({ baseline, exitCode }) => {
    const { rootDir, scriptPath, configDir } = createCliFixture();
    const baselinePath = path.join(configDir, "control-ui-startup-budget-baseline.json");
    if (baseline === null) {
      fs.unlinkSync(baselinePath);
    } else {
      fs.writeFileSync(baselinePath, baseline);
    }
    const report = runControlUiPerformanceCli(scriptPath, [], rootDir);
    expect(report.status, report.stderr).toBe(exitCode);
    const output = exitCode === 0 ? report.stdout : report.stderr;
    const command = output.match(/node --import [^\r\n]*?--reason "<reason>"/u)?.[0];
    // Never spawn an old raw-tsx hint: it could access the host's shared cache.
    expect(command).toBe(baselineUpdateCommand);

    const reason = "fixture hint update";
    const args = command!
      .slice("node ".length)
      .split(" ")
      .map((arg) => (arg === '"<reason>"' ? reason : arg));
    const env = { ...process.env };
    delete env.TSX_DISABLE_CACHE;
    const beforeDate = new Date().toISOString().slice(0, 10);
    const update = spawnSync(process.execPath, args, {
      cwd: rootDir,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(update.status, update.stderr).toBe(0);
    expect(update.stdout).toBe(
      `Updated config/control-ui-startup-budget-baseline.json to 65 B (${reason}).\n`,
    );
    const expectedBytes = [beforeDate, new Date().toISOString().slice(0, 10)].map(
      (updatedAt) => `${JSON.stringify({ startupJsGzipBytes: 65, reason, updatedAt }, null, 2)}\n`,
    );
    expect(expectedBytes).toContain(fs.readFileSync(baselinePath, "utf8"));
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
