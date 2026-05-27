import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGauntletPrebuildCommand,
  hasGauntletWorkRows,
  parseTimedMetrics,
  runMeasuredCommand,
  runMeasuredCommandLive,
} from "../../scripts/check-plugin-gateway-gauntlet.mjs";
import {
  buildGauntletPrebuildEnv,
  collectGatewayCpuObservations,
  collectMetricObservations,
  collectQaBaselineRegressionObservations,
  detectCommandDiagnosticFailure,
  discoverBundledPluginManifests,
  schemaHasRequiredFields,
  selectPluginEntries,
} from "../../scripts/lib/plugin-gateway-gauntlet.mjs";

describe("plugin gateway gauntlet helpers", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-gauntlet-"));
    await fs.mkdir(path.join(repoRoot, "extensions"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function writeManifest(pluginDir: string, fileName: string, source: string) {
    const dir = path.join(repoRoot, "extensions", pluginDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), source, "utf8");
  }

  it("discovers bundled plugin manifests into lifecycle matrix rows", async () => {
    await writeManifest(
      "alpha",
      "openclaw.plugin.json",
      JSON.stringify({
        id: "alpha",
        enabledByDefault: true,
        providers: ["openai"],
        commandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
        auth: [{ method: "oauth", onboardingScopes: ["models"] }],
        configSchema: {
          type: "object",
          properties: {
            nested: {
              type: "object",
              required: ["token"],
            },
          },
        },
      }),
    );
    await writeManifest(
      "beta",
      "openclaw.plugin.json",
      JSON.stringify({ id: "beta", commandAliases: ["dreaming"], onboardingScopes: ["memory"] }),
    );

    const matrix = discoverBundledPluginManifests(repoRoot);

    expect(matrix.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
    expect(matrix[0]).toEqual({
      activation: {},
      authMethods: ["oauth"],
      buildId: "alpha",
      channels: [],
      cliCommandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
      commandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
      dir: path.join("extensions", "alpha"),
      enabledByDefault: true,
      hasConfigSchema: true,
      hasRequiredConfigFields: true,
      id: "alpha",
      manifestPath: path.join("extensions", "alpha", "openclaw.plugin.json"),
      name: "alpha",
      onboardingScopes: ["models"],
      providers: ["openai"],
      runtimeSlashAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
      skills: [],
    });
    expect(matrix[1].runtimeSlashAliases).toEqual([
      { name: "dreaming", kind: "runtime-slash", cliCommand: null },
    ]);
    expect(matrix[1].buildId).toBe("beta");
  });

  it("keeps manifest ids separate from bounded build entry ids", async () => {
    await writeManifest("kimi-coding", "openclaw.plugin.json", JSON.stringify({ id: "kimi" }));

    const matrix = discoverBundledPluginManifests(repoRoot);

    expect(matrix).toEqual([
      expect.objectContaining({
        buildId: "kimi-coding",
        id: "kimi",
      }),
    ]);
    expect(buildGauntletPrebuildEnv({}, { buildIds: [matrix[0].buildId] })).toEqual({
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "kimi-coding",
    });
  });

  it("skips source-only plugin dirs that are excluded from the built runtime", async () => {
    await writeManifest("qa-lab", "openclaw.plugin.json", JSON.stringify({ id: "qa-lab" }));
    await writeManifest("qqbot", "openclaw.plugin.json", JSON.stringify({ id: "qqbot" }));
    await writeManifest("telegram", "openclaw.plugin.json", JSON.stringify({ id: "telegram" }));

    const matrix = discoverBundledPluginManifests(repoRoot);

    expect(matrix.map((entry) => entry.id)).toEqual(["telegram"]);
  });

  it("detects plugin load failures in successful command output", () => {
    expect(
      detectCommandDiagnosticFailure(
        "Installed plugin: qa-lab\n",
        "[plugins] qa-lab failed to load from /repo/extensions/qa-lab/index.ts: Error: nope\n",
      ),
    ).toBe("plugin-load-failure");
    expect(
      detectCommandDiagnosticFailure(
        "",
        "\u001B[36m[plugins]\u001B[39m qa-lab failed to load from /repo/extensions/qa-lab/index.ts: Error: nope\n",
      ),
    ).toBe("plugin-load-failure");
    expect(detectCommandDiagnosticFailure("Installed plugin: qa-lab\n", "")).toBeNull();
  });

  it("selects plugin shards after explicit id filtering", () => {
    const entries = ["a", "b", "c", "d"].map((id) => ({ id }));

    expect(selectPluginEntries(entries, { ids: ["d", "b"], shardTotal: 2, shardIndex: 0 })).toEqual(
      [{ id: "b" }],
    );
    expect(() => selectPluginEntries(entries, { ids: ["missing"] })).toThrow(
      "Unknown bundled plugin id(s): missing",
    );
  });

  it("detects required schema fields recursively", () => {
    expect(
      schemaHasRequiredFields({
        type: "object",
        properties: {
          auth: {
            oneOf: [{ type: "object" }, { type: "object", required: ["token"] }],
          },
        },
      }),
    ).toBe(true);
    expect(
      schemaHasRequiredFields({ type: "object", properties: { enabled: { type: "boolean" } } }),
    ).toBe(false);
  });

  it("flags gateway startup CPU observations using bench summary keys", () => {
    expect(
      collectGatewayCpuObservations({
        startup: {
          results: [
            {
              id: "default",
              summary: {
                cpuCoreRatio: { max: 1.1 },
                readyzMs: { max: 45_000 },
              },
            },
          ],
        },
        qa: {
          metrics: {
            gatewayCpuCoreRatio: 1.2,
            wallMs: 60_000,
          },
        },
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 30_000,
      }),
    ).toEqual([
      {
        kind: "startup-cpu-hot",
        id: "default",
        cpuCoreRatioMax: 1.1,
        wallMsMax: 45_000,
      },
      {
        kind: "qa-cpu-hot",
        id: "qa-suite",
        cpuCoreRatio: 1.2,
        wallMs: 60_000,
      },
    ]);
  });

  it("flags absolute peaks and phase-relative anomalies", () => {
    const observations = collectMetricObservations(
      [
        { pluginId: "a", phase: "lifecycle:install", wallMs: 100, maxRssMb: 100 },
        { pluginId: "b", phase: "lifecycle:install", wallMs: 110, maxRssMb: 110 },
        {
          pluginId: "c",
          phase: "lifecycle:install",
          wallMs: 1_000,
          cpuCoreRatio: 1.2,
          maxRssMb: 500,
        },
      ],
      {
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 900,
        maxRssWarnMb: 450,
        wallAnomalyMultiplier: 3,
        rssAnomalyMultiplier: 2.5,
      },
    );

    expect(observations.map((observation) => observation.kind)).toEqual([
      "phase-cpu-hot",
      "phase-wall-anomaly",
      "phase-rss-high",
      "phase-rss-anomaly",
    ]);
  });

  it("uses QA gateway metrics instead of source CLI wrapper CPU for QA hot observations", () => {
    const observations = collectMetricObservations(
      [
        {
          pluginId: "browser,memory-core",
          phase: "qa:rpc",
          wallMs: 40_000,
          cpuCoreRatio: 1.2,
          qaMetrics: {
            wallMs: 25_000,
            gatewayCpuCoreRatio: 0.42,
          },
        },
      ],
      {
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 30_000,
      },
    );

    expect(observations).toStrictEqual([]);
  });

  it("flags QA gateway regressions relative to an explicit baseline", () => {
    expect(
      collectQaBaselineRegressionObservations(
        [
          {
            pluginId: "<baseline>",
            phase: "qa:rpc",
            qaMetrics: { wallMs: 20_000, gatewayCpuCoreRatio: 0.25 },
          },
          {
            pluginId: "browser,memory-core",
            phase: "qa:rpc",
            qaMetrics: { wallMs: 45_000, gatewayCpuCoreRatio: 0.6 },
          },
        ],
        {
          cpuRegressionMultiplier: 2,
          wallRegressionMultiplier: 2,
        },
      ).map((observation) => observation.kind),
    ).toEqual(["qa-baseline-cpu-regression", "qa-baseline-wall-regression"]);
  });

  it("prebuilds private QA dist when QA chunks are enabled", () => {
    expect(buildGauntletPrebuildEnv({ EXISTING: "1" }, { includePrivateQa: true })).toEqual({
      EXISTING: "1",
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "qa-channel,qa-lab,qa-matrix",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    });
    const env = { EXISTING: "1" };
    expect(buildGauntletPrebuildEnv(env, { includePrivateQa: false })).toBe(env);
  });

  it("marks gauntlet prebuilds as runtime-only when requested", () => {
    expect(
      buildGauntletPrebuildEnv(
        { EXISTING: "1" },
        {
          buildIds: ["acpx"],
          skipDeclarationBuild: true,
        },
      ),
    ).toEqual({
      EXISTING: "1",
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "acpx",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    });
  });

  it("prebuilds only selected plugin dist entries for bounded gauntlet runs", () => {
    expect(
      buildGauntletPrebuildEnv(
        { EXISTING: "1" },
        {
          includePrivateQa: true,
          buildIds: ["active-memory", "acpx"],
        },
      ),
    ).toEqual({
      EXISTING: "1",
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "acpx,active-memory,qa-channel,qa-lab,qa-matrix",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    });
  });

  it("prebuilds only the CLI startup runtime needed by the gauntlet", () => {
    expect(createGauntletPrebuildCommand(repoRoot)).toEqual({
      command: process.execPath,
      args: [path.join(repoRoot, "scripts", "build-all.mjs"), "cliStartup"],
    });
  });

  it("does not count prebuild setup as gauntlet work", () => {
    expect(hasGauntletWorkRows([])).toBe(false);
    expect(hasGauntletWorkRows([{ phase: "prebuild" }])).toBe(false);
    expect(hasGauntletWorkRows([{ phase: "prebuild" }, { phase: "lifecycle:install" }])).toBe(
      true,
    );
    expect(hasGauntletWorkRows([{ phase: "slash:help" }])).toBe(true);
    expect(hasGauntletWorkRows([{ phase: "qa:rpc" }])).toBe(true);
  });

  it("parses macOS time -l metrics from strict trailing lines", () => {
    const metrics = parseTimedMetrics(
      [
        "plugin stderr: 99.00 real 99.00 user 99.00 sys nope",
        "        0.25 real         0.06 user         0.02 sys",
        "     2097152  maximum resident set size",
      ].join("\n"),
      250,
      "bsd",
    );

    expect(metrics.cpuMs).toBe(80);
    expect(metrics.cpuCoreRatio).toBeCloseTo(0.32);
    expect(metrics.maxRssMb).toBe(2);
  });

  it("marks spawn errors as failed measured rows", async () => {
    const logDir = path.join(repoRoot, "logs");
    const row = runMeasuredCommand({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: path.join(repoRoot, "missing-command"),
      args: [],
      label: "missing",
      phase: "probe",
      timeoutMs: 1000,
      timeMode: "none",
    });

    expect(row.status).toBe(1);
    expect(row.spawnError?.code).toBe("ENOENT");
    await expect(fs.readFile(row.logPath, "utf8")).resolves.toContain("[spawn error] ENOENT");
  });

  it("captures output from live measured commands", async () => {
    const logDir = path.join(repoRoot, "logs");
    const row = await runMeasuredCommandLive({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: process.execPath,
      args: ["-e", "console.log('live stdout'); console.error('live stderr')"],
      label: "live",
      phase: "probe",
      timeoutMs: 1000,
      timeMode: "none",
    });

    expect(row.status).toBe(0);
    await expect(fs.readFile(row.logPath, "utf8")).resolves.toContain("live stdout");
    await expect(fs.readFile(row.logPath, "utf8")).resolves.toContain("live stderr");
  });

  it("cleans parent signal handlers after live measured commands settle", async () => {
    const logDir = path.join(repoRoot, "logs");
    const before = process.listenerCount("SIGTERM");

    const row = await runMeasuredCommandLive({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: process.execPath,
      args: ["-e", ""],
      label: "live-signal-cleanup",
      phase: "probe",
      timeoutMs: 1000,
      timeMode: "none",
    });

    expect(row.status).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("bounds captured output from live measured commands", async () => {
    const logDir = path.join(repoRoot, "logs");
    const row = await runMeasuredCommandLive({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(32))"],
      label: "live-bounded",
      phase: "probe",
      timeoutMs: 1000,
      timeMode: "none",
      maxBufferBytes: 12,
    });

    expect(row.status).toBe(0);
    const log = await fs.readFile(row.logPath, "utf8");
    expect(log).toContain("x".repeat(12));
    expect(log).toContain("[stdout truncated after 12 bytes]");
  });

  it("force kills timed-out live measured process groups that ignore SIGTERM", async () => {
    const logDir = path.join(repoRoot, "logs");
    const markerPath = path.join(repoRoot, "timeout-marker.txt");
    const row = await runMeasuredCommandLive({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "const marker = process.argv[1];",
          "fs.writeFileSync(marker, 'start\\n');",
          "process.on('SIGTERM', () => fs.appendFileSync(marker, 'term\\n'));",
          "setInterval(() => fs.appendFileSync(marker, 'tick\\n'), 50);",
        ].join(""),
        markerPath,
      ],
      label: "live-timeout",
      phase: "probe",
      timeoutMs: 1000,
      timeoutKillGraceMs: 100,
    });

    expect(row.status).toBe(1);
    expect(row.timedOut).toBe(true);
    expect(row.spawnError?.code).toBe("ETIMEDOUT");
    expect(row.wallMs).toBeLessThan(5_000);
    const afterReturn = await fs.readFile(markerPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe(afterReturn);
  });

  it("fails dry runs that do not execute any gauntlet commands", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/check-plugin-gateway-gauntlet.mjs"),
        "--repo-root",
        repoRoot,
        "--output-dir",
        outputDir,
        "--skip-prebuild",
        "--skip-lifecycle",
        "--skip-slash-help",
        "--skip-qa",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("No lifecycle, slash-help, or QA gauntlet commands ran");
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.guardFailures).toEqual([
      expect.objectContaining({
        kind: "empty-run",
      }),
    ]);
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await expect(fs.stat(summary.isolatedRunRoot)).resolves.toBeTruthy();
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  });

  it("cleans the isolated run root after an explicitly empty dry run", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/check-plugin-gateway-gauntlet.mjs"),
        "--repo-root",
        repoRoot,
        "--output-dir",
        outputDir,
        "--skip-prebuild",
        "--skip-lifecycle",
        "--skip-slash-help",
        "--skip-qa",
        "--allow-empty",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.guardFailures).toEqual([]);
    expect(summary.isolatedRunRootPreserved).toBe(false);
    await expect(fs.stat(summary.isolatedRunRoot)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("carries bounded build ids into QA run-node chunks", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    await writeManifest("alpha", "openclaw.plugin.json", JSON.stringify({ id: "alpha" }));
    await fs.writeFile(path.join(repoRoot, "extensions", "alpha", "index.ts"), "export {};\n");
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "run-node.mjs"),
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'const outputArgIndex = process.argv.indexOf("--output-dir");',
        "const outputDir = path.resolve(process.cwd(), process.argv[outputArgIndex + 1]);",
        "fs.mkdirSync(outputDir, { recursive: true });",
        'fs.writeFileSync(path.join(outputDir, "env.txt"), process.env.OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS ?? "", "utf8");',
        'fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), JSON.stringify({ metrics: { wallMs: 1, gatewayCpuCoreRatio: 0 } }), "utf8");',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/check-plugin-gateway-gauntlet.mjs"),
        "--repo-root",
        repoRoot,
        "--output-dir",
        outputDir,
        "--skip-prebuild",
        "--skip-lifecycle",
        "--skip-slash-help",
        "--plugin",
        "alpha",
        "--qa-scenario",
        "channel-chat-baseline",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    await expect(
      fs.readFile(path.join(outputDir, "qa-suite", "chunk-00", "env.txt"), "utf8"),
    ).resolves.toBe("alpha,qa-channel,qa-lab,qa-matrix");
  });
});
