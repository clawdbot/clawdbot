// Plugin Gateway Gauntlet tests cover plugin gateway gauntlet script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildObservationGuardFailures,
  createGauntletPrebuildCommand,
  hasGauntletWorkRows,
  parseArgs,
  parseTimedMetrics,
  runMeasuredCommand,
  runMeasuredCommandLive,
} from "../../scripts/check-plugin-gateway-gauntlet.mjs";
import {
  buildGauntletPrebuildEnv,
  collectGatewayCpuObservations,
  collectMetricObservations,
  collectPluginsWithRequiredEntries,
  collectRequiredPluginEntries,
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function writeManifest(pluginDir: string, fileName: string, source: string) {
    const dir = path.join(repoRoot, "extensions", pluginDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), source, "utf8");
  }

  function minimalQaSuiteSummary(metrics: Record<string, number>) {
    return {
      counts: { failed: 0, passed: 1, total: 1 },
      metrics,
      run: {
        concurrency: 1,
        fastMode: false,
        finishedAt: "2026-05-30T00:00:01.000Z",
        primaryModel: "mock-openai/gpt-5.5",
        primaryModelName: "gpt-5.5",
        primaryProvider: "mock-openai",
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline"],
        startedAt: "2026-05-30T00:00:00.000Z",
      },
      scenarios: [
        {
          name: "channel-chat-baseline",
          status: "pass",
          steps: [{ name: "mock step", status: "pass" }],
        },
      ],
    };
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) {
        return;
      }
      await delay(25);
    }
    throw new Error("condition was not met before timeout");
  }

  async function waitForClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
    return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("child did not close before timeout"));
        }, timeoutMs);
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
  }

  it("stops parsing options after the argument terminator", () => {
    expect(parseArgs(["--plugin", "telegram", "--", "--plugin", "discord"])).toMatchObject({
      pluginIds: ["telegram"],
    });
  });

  it("accepts package-manager argument separators before script options", () => {
    expect(
      parseArgs([
        "--",
        "--plugin",
        "telegram",
        "--limit",
        "3",
        "--qa-scenario",
        "channel-chat-baseline",
      ]),
    ).toMatchObject({
      limit: 3,
      pluginIds: ["telegram"],
      qaScenarios: ["channel-chat-baseline"],
    });
  });

  it("rejects duplicate repeatable selectors", () => {
    expect(() => parseArgs(["--plugin", "telegram", "--plugin", "telegram"])).toThrow(
      "Duplicate --plugin value: telegram",
    );
    expect(() =>
      parseArgs([
        "--qa-scenario",
        "channel-chat-baseline",
        "--qa-scenario",
        "channel-chat-baseline",
      ]),
    ).toThrow("Duplicate --qa-scenario value: channel-chat-baseline");

    vi.stubEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS", "telegram,discord");
    expect(() => parseArgs(["--plugin", "telegram"])).toThrow("Duplicate --plugin value: telegram");
  });

  it("rejects duplicate single-value controls", () => {
    expect(() =>
      parseArgs(["--output-dir", ".artifacts/one", "--output-dir", ".artifacts/two"]),
    ).toThrow("--output-dir was provided more than once");
    expect(() => parseArgs(["--shard-total", "2", "--shard-total", "3"])).toThrow(
      "--shard-total was provided more than once",
    );
  });

  it("rejects valued flags followed by another option", () => {
    for (const flag of [
      "--repo-root",
      "--output-dir",
      "--plugin",
      "--shard-total",
      "--shard-index",
      "--limit",
      "--qa-scenario",
      "--qa-plugin-chunk-size",
      "--cpu-core-warn",
      "--hot-wall-warn-ms",
      "--max-rss-warn-mb",
      "--wall-anomaly-multiplier",
      "--rss-anomaly-multiplier",
      "--qa-cpu-regression-multiplier",
      "--qa-wall-regression-multiplier",
      "--command-timeout-ms",
      "--build-timeout-ms",
      "--qa-timeout-ms",
    ]) {
      for (const value of ["--skip-qa", "-h"]) {
        expect(() => parseArgs([flag, value])).toThrow(`Missing value for ${flag}`);
      }
    }
  });

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
      requiredPlugins: [],
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
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
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

  it("collects required plugin support outside the selected shard", () => {
    const entries = [
      { id: "alpha", requiredPlugins: ["beta"] },
      { id: "beta", requiredPlugins: ["gamma"] },
      { id: "gamma" },
      { id: "delta" },
    ];
    const selected = selectPluginEntries(entries, {
      ids: ["alpha"],
      shardTotal: 2,
      shardIndex: 0,
    });

    expect(collectRequiredPluginEntries(entries, selected).map((entry) => entry.id)).toEqual([
      "gamma",
      "beta",
    ]);
    expect(collectPluginsWithRequiredEntries(entries, selected).map((entry) => entry.id)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);
  });

  it("rejects missing bundled plugin requirements", () => {
    const entries = [{ id: "alpha", requiredPlugins: ["missing"] }];

    expect(() => collectRequiredPluginEntries(entries, entries)).toThrow(
      'Bundled plugin "alpha" requires unknown bundled plugin "missing"',
    );
  });

  it("rejects bundled plugin requirement cycles", () => {
    const entries = [
      { id: "alpha", requiredPlugins: ["beta"] },
      { id: "beta", requiredPlugins: ["alpha"] },
    ];

    expect(() => collectRequiredPluginEntries(entries, [entries[0]])).toThrow(
      "Bundled plugin dependency cycle detected: alpha -> beta -> alpha",
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

  it("marks first work-row anomalies as cold-start observations", () => {
    const observations = collectMetricObservations(
      [
        { phase: "prebuild", wallMs: 100, maxRssMb: 100 },
        {
          pluginId: "first-plugin",
          phase: "lifecycle:install",
          wallMs: 1_000,
          cpuCoreRatio: 1.2,
          maxRssMb: 500,
        },
        { pluginId: "second-plugin", phase: "lifecycle:install", wallMs: 100, maxRssMb: 100 },
        { pluginId: "third-plugin", phase: "lifecycle:install", wallMs: 110, maxRssMb: 110 },
      ],
      {
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 900,
        maxRssWarnMb: 450,
        wallAnomalyMultiplier: 3,
        rssAnomalyMultiplier: 2.5,
      },
    );

    expect(observations).toEqual([
      expect.objectContaining({ kind: "phase-cpu-hot", coldStart: true }),
      expect.objectContaining({ kind: "phase-wall-anomaly", coldStart: true }),
      expect.objectContaining({ kind: "phase-rss-high", coldStart: true }),
      expect.objectContaining({ kind: "phase-rss-anomaly", coldStart: true }),
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
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "qa-channel,qa-lab",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
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
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
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
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "acpx,active-memory,qa-channel,qa-lab",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    });
  });

  it("preserves caller pnpm dependency verification overrides in gauntlet prebuilds", () => {
    expect(
      buildGauntletPrebuildEnv(
        { EXISTING: "1", PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "true" },
        { includePrivateQa: true },
      ),
    ).toMatchObject({
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "true",
    });
  });

  it("prebuilds only the QA runtime needed by the gauntlet", () => {
    expect(createGauntletPrebuildCommand(repoRoot)).toEqual({
      command: process.execPath,
      args: [path.join(repoRoot, "scripts", "build-all.mjs"), "qaRuntime"],
    });
  });

  it("does not count prebuild setup as gauntlet work", () => {
    expect(hasGauntletWorkRows([])).toBe(false);
    expect(hasGauntletWorkRows([{ phase: "prebuild" }])).toBe(false);
    expect(hasGauntletWorkRows([{ phase: "prebuild" }, { phase: "lifecycle:install" }])).toBe(true);
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
    const row = await runMeasuredCommand({
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

  it("clamps oversized measured command timers before scheduling", async () => {
    const logDir = path.join(repoRoot, "logs");
    const row = await runMeasuredCommandLive({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 25)"],
      label: "oversized-timeout",
      phase: "probe",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      timeMode: "none",
    });

    expect(row.status).toBe(0);
    expect(row.timedOut).toBe(false);
    await expect(fs.readFile(row.logPath, "utf8")).resolves.not.toContain("ETIMEDOUT");
  });

  it.runIf(process.platform !== "win32")(
    "kills timed-out measured command process groups when the leader exits first",
    async () => {
      const logDir = path.join(repoRoot, "logs");
      const scriptPath = path.join(repoRoot, "leader-exits.mjs");
      const grandchildPidPath = path.join(repoRoot, "grandchild.pid");
      let grandchildPid = 0;
      await fs.writeFile(
        scriptPath,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      try {
        const rowPromise = runMeasuredCommand({
          cwd: repoRoot,
          env: process.env,
          logDir,
          command: process.execPath,
          args: [scriptPath, grandchildPidPath],
          label: "timeout-leader-exits",
          phase: "probe",
          timeoutKillGraceMs: 25,
          timeoutMs: 250,
          timeMode: "none",
        });

        await waitFor(() =>
          fs
            .access(grandchildPidPath)
            .then(() => true)
            .catch(() => false),
        );
        grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(isProcessAlive(grandchildPid)).toBe(true);

        const row = await rowPromise;
        expect(row.timedOut).toBe(true);
        expect(row.spawnError?.code).toBe("ETIMEDOUT");
        await waitFor(() => !isProcessAlive(grandchildPid));
      } finally {
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "lets timed-out measured command descendants drain during kill grace",
    async () => {
      const logDir = path.join(repoRoot, "logs");
      const scriptPath = path.join(repoRoot, "leader-exits-drain.mjs");
      const readyPath = path.join(repoRoot, "grandchild.ready");
      const drainedPath = path.join(repoRoot, "grandchild.drained");
      await fs.writeFile(
        scriptPath,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchildScript = [
  "const fs = require('node:fs');",
  "process.on('SIGTERM', () => {",
  "  setTimeout(() => {",
  "    fs.writeFileSync(process.argv[3], 'drained');",
  "    process.exit(0);",
  "  }, 50);",
  "});",
  "fs.writeFileSync(process.argv[2], 'ready');",
  "setInterval(() => {}, 1000);",
].join("\\n");
spawn(process.execPath, ["-e", grandchildScript, "child", process.argv[2], process.argv[3]], {
  stdio: "ignore",
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      const rowPromise = runMeasuredCommand({
        cwd: repoRoot,
        env: process.env,
        logDir,
        command: process.execPath,
        args: [scriptPath, readyPath, drainedPath],
        label: "timeout-leader-drain",
        phase: "probe",
        timeoutKillGraceMs: 1_000,
        timeoutMs: 500,
        timeMode: "none",
      });

      await waitFor(() =>
        fs
          .access(readyPath)
          .then(() => true)
          .catch(() => false),
      );
      const row = await rowPromise;

      expect(row.timedOut).toBe(true);
      expect(row.spawnError?.code).toBe("ETIMEDOUT");
      await expect(fs.readFile(drainedPath, "utf8")).resolves.toBe("drained");
    },
  );

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

  it("returns a failed row when measured command log writing fails", async () => {
    const logDir = path.join(repoRoot, "not-a-directory");
    await fs.writeFile(logDir, "blocks log directory creation", "utf8");

    const row = await runMeasuredCommandLive({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: process.execPath,
      args: ["-e", "console.log('live stdout')"],
      label: "live-log-failure",
      phase: "probe",
      timeoutMs: 1000,
      timeMode: "none",
    });

    expect(row.status).toBe(1);
    expect(row.diagnosticFailure).toBe("command-log-write-failure");
    expect(row.logPath).toBeNull();
    expect(row.logWriteError).toMatch(/EEXIST|ENOTDIR|not a directory/u);
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

  it.runIf(process.platform !== "win32")(
    "cleans parent-terminated measured process groups when the leader exits first",
    async () => {
      const logDir = path.join(repoRoot, "logs");
      const harnessPath = path.join(repoRoot, "parent-termination-harness.mjs");
      const scriptPath = path.join(repoRoot, "parent-termination-leader.mjs");
      const grandchildPidPath = path.join(repoRoot, "grandchild.pid");
      const grandchildReadyPath = path.join(repoRoot, "grandchild.ready");
      let grandchildPid = 0;

      await fs.writeFile(
        scriptPath,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchildScript = [
  "const fs = require('node:fs');",
  "process.on('SIGTERM', () => {});",
  "process.on('SIGHUP', () => {});",
  "fs.writeFileSync(process.argv[2], 'ready');",
  "setInterval(() => {}, 1000);",
].join("\\n");
const grandchild = spawn(process.execPath, ["-e", grandchildScript, "child", process.argv[3]], {
  stdio: "ignore",
});
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        "utf8",
      );
      await fs.writeFile(
        harnessPath,
        `
import { runMeasuredCommandLive } from ${JSON.stringify(
          pathToFileURL(path.resolve("scripts/check-plugin-gateway-gauntlet.mjs")).href,
        )};

await runMeasuredCommandLive({
  cwd: ${JSON.stringify(repoRoot)},
  env: process.env,
  logDir: ${JSON.stringify(logDir)},
  command: process.execPath,
  args: [${JSON.stringify(scriptPath)}, ${JSON.stringify(grandchildPidPath)}, ${JSON.stringify(
    grandchildReadyPath,
  )}],
  label: "parent-termination-leader-exits",
  phase: "probe",
  timeoutKillGraceMs: 25,
  timeoutMs: 60_000,
  timeMode: "none",
});
`,
        "utf8",
      );

      const harness = spawn(process.execPath, [harnessPath], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitFor(async () => {
          try {
            await fs.access(grandchildReadyPath);
            return true;
          } catch {
            return false;
          }
        });
        grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
        expect(isProcessAlive(grandchildPid)).toBe(true);

        harness.kill("SIGTERM");
        await expect(waitForClose(harness)).resolves.toEqual({ code: null, signal: "SIGTERM" });
        await waitFor(() => !isProcessAlive(grandchildPid));
      } finally {
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
        if (harness.pid && isProcessAlive(harness.pid)) {
          harness.kill("SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rethrows parent termination received during timeout cleanup",
    async () => {
      const logDir = path.join(repoRoot, "logs");
      const harnessPath = path.join(repoRoot, "timeout-parent-termination-harness.mjs");
      const scriptPath = path.join(repoRoot, "timeout-parent-termination-leader.mjs");
      const grandchildPidPath = path.join(repoRoot, "timeout-grandchild.pid");
      const grandchildReadyPath = path.join(repoRoot, "timeout-grandchild.ready");
      const leaderExitedPath = path.join(repoRoot, "timeout-leader.exited");
      let grandchildPid = 0;

      await fs.writeFile(
        scriptPath,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchildScript = [
  "const fs = require('node:fs');",
  "process.on('SIGTERM', () => {});",
  "process.on('SIGHUP', () => {});",
  "fs.writeFileSync(process.argv[2], 'ready');",
  "setInterval(() => {}, 1000);",
].join("\\n");
const grandchild = spawn(process.execPath, ["-e", grandchildScript, "child", process.argv[3]], {
  stdio: "ignore",
});
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[4], "exited");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
        "utf8",
      );
      await fs.writeFile(
        harnessPath,
        `
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runMeasuredCommandLive } from ${JSON.stringify(
          pathToFileURL(path.resolve("scripts/check-plugin-gateway-gauntlet.mjs")).href,
        )};

const promise = runMeasuredCommandLive({
  cwd: ${JSON.stringify(repoRoot)},
  env: process.env,
  logDir: ${JSON.stringify(logDir)},
  command: process.execPath,
  args: [${JSON.stringify(scriptPath)}, ${JSON.stringify(grandchildPidPath)}, ${JSON.stringify(
    grandchildReadyPath,
  )}, ${JSON.stringify(leaderExitedPath)}],
  label: "timeout-parent-termination",
  phase: "probe",
  timeoutKillGraceMs: 250,
  timeoutMs: 200,
  timeMode: "none",
});
for (let attempt = 0; attempt < 200 && !fs.existsSync(${JSON.stringify(
          leaderExitedPath,
        )}); attempt += 1) {
  await delay(25);
}
if (!fs.existsSync(${JSON.stringify(leaderExitedPath)})) {
  process.exit(2);
}
await delay(50);
process.kill(process.pid, "SIGTERM");
await promise;
process.exit(7);
`,
        "utf8",
      );

      const harness = spawn(process.execPath, [harnessPath], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitFor(async () => {
          try {
            await fs.access(grandchildReadyPath);
            return true;
          } catch {
            return false;
          }
        });
        grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);

        await expect(waitForClose(harness)).resolves.toEqual({ code: null, signal: "SIGTERM" });
        await waitFor(() => !isProcessAlive(grandchildPid));
      } finally {
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
        if (harness.pid && isProcessAlive(harness.pid)) {
          harness.kill("SIGKILL");
        }
      }
    },
  );

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

  it("bounds relayed output from live measured commands", async () => {
    const logDir = path.join(repoRoot, "logs");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    });

    const row = await runMeasuredCommandLive({
      cwd: repoRoot,
      env: process.env,
      logDir,
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(32))"],
      label: "live-relay-bounded",
      phase: "probe",
      timeoutMs: 1000,
      timeMode: "none",
      consoleOutputMaxBytes: 12,
      maxBufferBytes: 64,
    });

    const relayed = writes.join("");
    expect(row.status).toBe(0);
    expect(relayed).toContain("x".repeat(12));
    expect(relayed).not.toContain("x".repeat(32));
    expect(relayed).toContain("[stdout relay truncated after 12 bytes]");
    await expect(fs.readFile(row.logPath, "utf8")).resolves.toContain("x".repeat(32));
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
          "setInterval(() => fs.appendFileSync(marker, 'tick\\n'), 5);",
        ].join(""),
        markerPath,
      ],
      label: "live-timeout",
      phase: "probe",
      timeoutMs: 100,
      timeoutKillGraceMs: 10,
    });

    expect(row.status).toBe(1);
    expect(row.timedOut).toBe(true);
    expect(row.spawnError?.code).toBe("ETIMEDOUT");
    expect(row.wallMs).toBeLessThan(5_000);
    const afterReturn = await fs.readFile(markerPath, "utf8");
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
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

  it("rejects non-decimal gauntlet numeric options", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/check-plugin-gateway-gauntlet.mjs"),
        "--skip-prebuild",
        "--skip-lifecycle",
        "--skip-slash-help",
        "--skip-qa",
        "--allow-empty",
        "--limit",
        "1e3",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--limit must be a positive integer");
  });

  it("documents gauntlet guardrail options and env defaults in help", () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/check-plugin-gateway-gauntlet.mjs"), "--help"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    for (const text of [
      "--wall-anomaly-multiplier",
      "--rss-anomaly-multiplier",
      "--qa-cpu-regression-multiplier",
      "--qa-wall-regression-multiplier",
      "--command-timeout-ms",
      "--build-timeout-ms",
      "--qa-timeout-ms",
      "OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS",
      "OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_TOTAL",
      "OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_INDEX",
      "OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_FAIL_ON_OBSERVATION",
      "OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_KEEP_RUN_ROOT",
      "OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_QA_SUMMARY_MAX_BYTES",
    ]) {
      expect(result.stdout).toContain(text);
    }
  });

  it("fails once when skip-prebuild leaves plugin lifecycle probes without a built entry", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    await writeManifest("acpx", "openclaw.plugin.json", JSON.stringify({ id: "acpx" }));

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/check-plugin-gateway-gauntlet.mjs"),
        "--repo-root",
        repoRoot,
        "--output-dir",
        outputDir,
        "--skip-prebuild",
        "--skip-qa",
        "--plugin",
        "acpx",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Cannot find module");
    expect(result.stderr).not.toContain("[plugin-gauntlet] acpx install");
    expect(result.stdout).toContain("failure missing-built-entry");

    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.rows).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.guardFailures).toEqual([
      {
        kind: "missing-built-entry",
        message:
          "dist/entry.js is missing; run without --skip-prebuild or build the gauntlet runtime first.",
      },
    ]);
  });

  it("allows skip-prebuild slash-only dry runs when selected plugins have no slash probes", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    await writeManifest("acpx", "openclaw.plugin.json", JSON.stringify({ id: "acpx" }));

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
        "--skip-qa",
        "--allow-empty",
        "--plugin",
        "acpx",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("missing-built-entry");

    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.rows).toEqual([]);
    expect(summary.guardFailures).toEqual([]);
  });

  it("parses observation failure mode from CLI and env", () => {
    expect(parseArgs(["--fail-on-observation", "--allow-empty"])).toMatchObject({
      allowEmpty: true,
      failOnObservation: true,
    });

    vi.stubEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_FAIL_ON_OBSERVATION", "1");
    expect(parseArgs(["--allow-empty"])).toMatchObject({
      allowEmpty: true,
      failOnObservation: true,
    });
  });

  it("promotes gauntlet observations to guard failures when requested", () => {
    const observations = [
      { kind: "phase-rss-high", phase: "qa:rpc", pluginId: "kitchen", maxRssMb: 2048 },
    ];

    expect(buildObservationGuardFailures(observations, false)).toEqual([]);
    expect(buildObservationGuardFailures(observations, true)).toEqual([
      {
        kind: "observation:phase-rss-high",
        message: "Gauntlet observation threshold exceeded: phase-rss-high",
        observation: observations[0],
      },
    ]);
  });

  it("does not promote setup and first cold-start observations to guard failures", () => {
    const observations = [
      { kind: "phase-rss-high", phase: "prebuild", maxRssMb: 2214 },
      {
        kind: "phase-wall-anomaly",
        phase: "lifecycle:install",
        pluginId: "acpx",
        wallMs: 17_148,
        coldStart: true,
      },
      {
        kind: "phase-wall-anomaly",
        phase: "lifecycle:install",
        pluginId: "steady-plugin",
        wallMs: 17_148,
      },
    ];

    expect(buildObservationGuardFailures(observations, true)).toEqual([
      {
        kind: "observation:phase-wall-anomaly",
        message: "Gauntlet observation threshold exceeded: phase-wall-anomaly",
        observation: observations[2],
      },
    ]);
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

  it("does not parse QA summary limit env when QA is skipped", () => {
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
        env: {
          ...process.env,
          OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_QA_SUMMARY_MAX_BYTES: "not-a-number",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("failures=0");
  });

  it.each([
    ["probes plugin-owned slash help while the plugin is installed", "default", [], 0],
    ["skips plugin-owned slash help when requested", "skip", ["--skip-slash-help"], 0],
    [
      "rejects slash-only probes without the install lifecycle",
      "slash-only",
      ["--skip-lifecycle"],
      1,
    ],
  ] as const)("%s", async (_title, mode, extraArgs, expectedStatus) => {
    const outputDir = path.join(repoRoot, `artifacts-${mode}`);
    await writeManifest(
      "workboard",
      "openclaw.plugin.json",
      JSON.stringify({
        id: "workboard",
        commandAliases: [
          {
            name: "workboard",
            kind: "runtime-slash",
            cliCommand: "workboard",
          },
        ],
      }),
    );
    await fs.writeFile(path.join(repoRoot, "extensions", "workboard", "index.ts"), "export {};\n");
    await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "dist", "entry.js"),
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const stateDir = process.env.OPENCLAW_STATE_DIR ?? process.cwd();",
        'const marker = path.join(stateDir, "workboard-enabled");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "plugins") {',
        '  if (args[1] === "install" || args[1] === "enable") fs.writeFileSync(marker, "1");',
        '  if (args[1] === "disable" || args[1] === "uninstall") fs.rmSync(marker, { force: true });',
        '  if (args[1] === "inspect") console.log("{}");',
        "  process.exit(0);",
        "}",
        'if (args[0] === "workboard" && args[1] === "--help") {',
        "  if (fs.existsSync(marker)) {",
        '    console.log("Usage: openclaw workboard");',
        "    process.exit(0);",
        "  }",
        '  console.error("workboard help was probed after uninstall");',
        "  process.exit(1);",
        "}",
        "process.exit(0);",
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
        "--skip-qa",
        ...extraArgs,
        "--plugin",
        "workboard",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(expectedStatus);
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    if (mode === "default") {
      expect(summary.failures).toEqual([]);
      const slashHelpRow = summary.rows.find(
        (row: { label?: string; logPath?: string }) =>
          row.label === "workboard-slash-help:workboard",
      );
      expect(summary.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "workboard-slash-help:workboard",
            phase: "slash:help",
            pluginId: "workboard",
            status: 0,
          }),
        ]),
      );
      const slashHelpLogPath = slashHelpRow?.logPath;
      expect(slashHelpLogPath).toEqual(expect.any(String));
      await expect(fs.readFile(slashHelpLogPath as string, "utf8")).resolves.toContain(
        "Usage: openclaw workboard",
      );
      return;
    }

    if (mode === "skip") {
      expect(summary.failures).toEqual([]);
      expect(summary.rows).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "slash:help",
            pluginId: "workboard",
          }),
        ]),
      );
      return;
    }

    expect(summary.guardFailures).toEqual([]);
    expect(summary.failures).toEqual([
      expect.objectContaining({
        label: "workboard-slash-workboard",
        phase: "slash:help",
        pluginId: "workboard",
        status: 1,
      }),
    ]);
  });

  it("carries required plugin build ids and enables dependencies in QA chunks", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    const qaSummaryJson = JSON.stringify(
      minimalQaSuiteSummary({ gatewayCpuCoreRatio: 0, wallMs: 1 }),
    );
    await writeManifest(
      "alpha",
      "openclaw.plugin.json",
      JSON.stringify({ id: "alpha", requiresPlugins: ["beta"] }),
    );
    await writeManifest("beta", "openclaw.plugin.json", JSON.stringify({ id: "beta" }));
    await fs.writeFile(path.join(repoRoot, "extensions", "alpha", "index.ts"), "export {};\n");
    await fs.writeFile(path.join(repoRoot, "extensions", "beta", "index.ts"), "export {};\n");
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
        'fs.writeFileSync(path.join(outputDir, "args.txt"), process.argv.slice(2).join("\\n"), "utf8");',
        `fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), ${JSON.stringify(qaSummaryJson)}, "utf8");`,
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
    ).resolves.toBe("alpha,beta,qa-channel,qa-lab");
    await expect(
      fs.readFile(path.join(outputDir, "qa-suite", "chunk-00", "args.txt"), "utf8"),
    ).resolves.toContain(["--enable-plugin", "beta", "--enable-plugin", "alpha"].join("\n"));
  });

  it("installs required plugins around a dependent plugin lifecycle probe", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    await writeManifest(
      "alpha",
      "openclaw.plugin.json",
      JSON.stringify({ id: "alpha", requiresPlugins: ["beta"] }),
    );
    await writeManifest("beta", "openclaw.plugin.json", JSON.stringify({ id: "beta" }));
    await fs.writeFile(path.join(repoRoot, "extensions", "alpha", "index.ts"), "export {};\n");
    await fs.writeFile(path.join(repoRoot, "extensions", "beta", "index.ts"), "export {};\n");
    await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "dist", "entry.js"),
      "if (process.argv[3] === 'inspect') console.log('{}');\n",
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
        "--skip-qa",
        "--skip-slash-help",
        "--plugin",
        "alpha",
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
    expect(summary.rows.map((row: { label: string }) => row.label)).toEqual([
      "alpha-requires-beta-install",
      "alpha-install",
      "alpha-inspect",
      "alpha-disable",
      "alpha-enable",
      "alpha-doctor",
      "alpha-uninstall",
      "alpha-requires-beta-uninstall",
    ]);
  });

  it("fails successful QA chunks whose summary reports failed scenarios", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    const qaSummaryJson = JSON.stringify({
      counts: { failed: 1, passed: 1, total: 2 },
      metrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
      run: {
        concurrency: 1,
        fastMode: false,
        finishedAt: "2026-05-30T00:00:01.000Z",
        primaryModel: "mock-openai/gpt-5.5",
        primaryModelName: "gpt-5.5",
        primaryProvider: "mock-openai",
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline", "gateway-restart-inflight-run"],
        startedAt: "2026-05-30T00:00:00.000Z",
      },
      scenarios: [
        { name: "channel-chat-baseline", status: "pass", steps: [] },
        { name: "gateway-restart-inflight-run", status: "fail", steps: [] },
      ],
    });
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
        `fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), ${JSON.stringify(qaSummaryJson)}, "utf8");`,
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
        "--qa-scenario",
        "gateway-restart-inflight-run",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("diagnostic=qa-summary-failed-scenarios");
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.failures).toEqual([
      expect.objectContaining({
        diagnosticDetail: "QA suite reported 1 failed scenario(s)",
        diagnosticFailure: "qa-summary-failed-scenarios",
        phase: "qa:rpc",
        pluginId: "alpha",
        status: 0,
      }),
    ]);
    expect(summary.rows[0]).toEqual(
      expect.objectContaining({
        diagnosticFailure: "qa-summary-failed-scenarios",
        qaMetrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
      }),
    );
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  });

  it("fails successful QA chunks whose passed scenarios have no step evidence", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    const qaSummaryJson = JSON.stringify({
      counts: { failed: 0, passed: 1, total: 1 },
      metrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
      run: {
        concurrency: 1,
        fastMode: false,
        finishedAt: "2026-05-30T00:00:01.000Z",
        primaryModel: "mock-openai/gpt-5.5",
        primaryModelName: "gpt-5.5",
        primaryProvider: "mock-openai",
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline"],
        startedAt: "2026-05-30T00:00:00.000Z",
      },
      scenarios: [{ name: "channel-chat-baseline", status: "pass", steps: [] }],
    });
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
        `fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), ${JSON.stringify(qaSummaryJson)}, "utf8");`,
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

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("diagnostic=qa-summary-invalid");
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.failures).toEqual([
      expect.objectContaining({
        diagnosticDetail:
          "QA suite summary passed scenario has no step evidence: channel-chat-baseline",
        diagnosticFailure: "qa-summary-invalid",
        phase: "qa:rpc",
        pluginId: "alpha",
        status: 0,
      }),
    ]);
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  });

  it("fails successful QA chunks whose scenario statuses disagree with counts", async () => {
    const outputDir = path.join(repoRoot, "artifacts");
    const qaSummaryJson = JSON.stringify({
      counts: { failed: 0, passed: 1, total: 2 },
      metrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
      run: {
        concurrency: 1,
        fastMode: false,
        finishedAt: "2026-05-30T00:00:01.000Z",
        primaryModel: "mock-openai/gpt-5.5",
        primaryModelName: "gpt-5.5",
        primaryProvider: "mock-openai",
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline", "gateway-restart-inflight-run"],
        startedAt: "2026-05-30T00:00:00.000Z",
      },
      scenarios: [
        { name: "channel-chat-baseline", status: "pass", steps: [] },
        { name: "gateway-restart-inflight-run", status: "fail", steps: [] },
      ],
    });
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
        `fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), ${JSON.stringify(qaSummaryJson)}, "utf8");`,
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
        "--qa-scenario",
        "gateway-restart-inflight-run",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("diagnostic=qa-summary-invalid");
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.failures).toEqual([
      expect.objectContaining({
        diagnosticDetail:
          "QA suite summary failed count mismatch: counts.failed=0, failed scenarios=1",
        diagnosticFailure: "qa-summary-invalid",
        phase: "qa:rpc",
        pluginId: "alpha",
        status: 0,
      }),
    ]);
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  });

  it("fails successful QA chunks that do not write the requested summary", async () => {
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
        'console.log("fake QA completed without writing qa-suite-summary.json");',
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

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("diagnostic=qa-summary-missing");
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.failures).toEqual([
      expect.objectContaining({
        diagnosticFailure: "qa-summary-missing",
        phase: "qa:rpc",
        pluginId: "alpha",
        status: 0,
      }),
    ]);
    expect(summary.rows[0]).toEqual(
      expect.objectContaining({
        diagnosticFailure: "qa-summary-missing",
        qaSummaryPath: path.join(outputDir, "qa-suite", "chunk-00", "qa-suite-summary.json"),
      }),
    );
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  });

  it("fails successful QA chunks that write unusable summary JSON", async () => {
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
        'fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), "{}", "utf8");',
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

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("diagnostic=qa-summary-invalid");
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.failures).toEqual([
      expect.objectContaining({
        diagnosticDetail: "QA suite summary missing scenarios array",
        diagnosticFailure: "qa-summary-invalid",
        phase: "qa:rpc",
        pluginId: "alpha",
        status: 0,
      }),
    ]);
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  });

  it("fails successful QA chunks that write oversized summary JSON", async () => {
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
        'fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), JSON.stringify({ filler: "x".repeat(128) }), "utf8");',
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
        env: {
          ...process.env,
          OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_QA_SUMMARY_MAX_BYTES: "64",
        },
      },
    );

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("diagnostic=qa-summary-invalid");
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
    expect(summary.failures).toEqual([
      expect.objectContaining({
        diagnosticDetail: expect.stringContaining("QA suite summary exceeded 64 bytes"),
        diagnosticFailure: "qa-summary-invalid",
        phase: "qa:rpc",
        pluginId: "alpha",
        status: 0,
      }),
    ]);
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  });
});
