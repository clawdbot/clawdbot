import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGauntletPrebuildEnv,
  collectGatewayCpuObservations,
  collectMetricObservations,
  collectQaBaselineRegressionObservations,
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
  });

  it("skips source-only plugin dirs that are excluded from the built runtime", async () => {
    await writeManifest("qqbot", "openclaw.plugin.json", JSON.stringify({ id: "qqbot" }));
    await writeManifest("telegram", "openclaw.plugin.json", JSON.stringify({ id: "telegram" }));

    const matrix = discoverBundledPluginManifests(repoRoot);

    expect(matrix.map((entry) => entry.id)).toEqual(["telegram"]);
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
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    });
    const env = { EXISTING: "1" };
    expect(buildGauntletPrebuildEnv(env, { includePrivateQa: false })).toBe(env);
  });
});
