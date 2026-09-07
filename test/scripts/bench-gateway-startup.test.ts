// Bench Gateway Startup tests cover bench gateway startup script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type RequestListener } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-gateway-startup.ts";
import { isStartupTraceDuration } from "../../scripts/lib/gateway-startup-trace-ranking.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { validateConfigObject } from "../../src/config/validation.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { registerStopChildBehaviorTests } from "./bench-gateway-child-test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function listenOnLoopback(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected loopback port");
  }
  return { port: address.port, server };
}

describe("gateway startup benchmark script", () => {
  let helpResult: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    helpResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-gateway-startup.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      },
    );
  });

  it("prints help without running benchmark cases", () => {
    expect(helpResult.status).toBe(0);
    expect(helpResult.stdout).toContain("OpenClaw Gateway startup benchmark");
    expect(helpResult.stdout).toContain("--case <id>");
    expect(helpResult.stdout).toContain("--cpu-prof-dir <dir>");
    expect(helpResult.stdout).toContain("--heap-prof-dir <dir>");
    expect(helpResult.stdout).toContain("default (gateway default)");
    expect(helpResult.stdout).not.toContain("[gateway-startup-bench]");
    expect(helpResult.stderr).toBe("");
  });

  it("rejects ambiguous benchmark CLI values before spawning Node", () => {
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
    expect(
      testing.parseOptions([
        "--case",
        "default",
        "--output",
        "startup.json",
        "--json",
        "--heap-prof-dir",
        "profiles",
        "--runs",
        "2",
      ]),
    ).toMatchObject({
      cases: [{ id: "default" }],
      json: true,
      heapProfDir: "profiles",
      output: "startup.json",
      runs: 2,
    });
    expect(() => testing.parseOptions(["--output", "--case", "default"])).toThrow(
      "--output requires a value",
    );
    expect(() => testing.parseOptions(["--case"])).toThrow("--case requires a value");
    expect(() => testing.parseOptions(["--runs", "--warmup", "0"])).toThrow(
      "--runs requires a value",
    );
    expect(() => testing.parseOptions(["--case", "default", "--case", "default"])).toThrow(
      'Duplicate --case "default"',
    );
    expect(() =>
      testing.parseOptions(["--output", "first.json", "--output", "second.json"]),
    ).toThrow("--output was provided more than once");
  });

  it("rejects unknown benchmark CLI args before running cases", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-gateway-startup.ts", "--wat"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("reports duplicate benchmark cases without a stack trace", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/bench-gateway-startup.ts",
        "--case",
        "default",
        "--case",
        "default",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe('Duplicate --case "default"');
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("does not disable local-check policy in the child gateway environment", () => {
    const env = testing.sanitizedEnv("/tmp/openclaw-bench", "/tmp/openclaw-bench/config.json", {
      config: {},
      id: "default",
      name: "gateway default",
    });

    expect(env.OPENCLAW_LOCAL_CHECK).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_STARTUP_TRACE).toBe("1");
  });

  it("forces incident packaged-plugin cases to load built plugin entries", () => {
    const benchCase = testing.parseOptions(["--case", "incidentCombined"]).cases[0];
    if (!benchCase) {
      throw new Error("expected combined incident benchmark case");
    }

    const env = testing.sanitizedEnv(
      "/tmp/openclaw-bench",
      "/tmp/openclaw-bench/config.json",
      benchCase,
    );

    expect(env.OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK).toBe("1");
    expect(env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS).toBeUndefined();
  });

  it("requires the full packaged plugin inventory even when a build filter is set", () => {
    const filteredEnv = { ...process.env, OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "telegram" };

    expect(testing.listIncidentPackagedPluginArtifacts(filteredEnv)).toEqual(
      testing.listIncidentPackagedPluginArtifacts({
        ...process.env,
        OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined,
      }),
    );
  });

  it("classifies HTTP listen and gateway ready logs separately", () => {
    expect(
      testing.classifyGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)"),
    ).toBe("http-listen");
    expect(testing.classifyGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe(
      "gateway-ready",
    );
    expect(testing.classifyGatewayReadyLog("[gateway] ready")).toBe("gateway-ready");
    expect(testing.classifyGatewayReadyLog("[gateway] starting HTTP server...")).toBeNull();
  });

  it("preserves ready and trace records split across output chunks", () => {
    const chunks = [
      "[gateway] rea",
      "dy (0 plugins, 0.8s)\nstartup trace: side",
      "cars.ready 2.0ms total=7.5ms heapUsedMb=12.0\n",
    ];
    let carry = "";
    const lines: string[] = [];
    for (const chunk of chunks) {
      const parsed = testing.collectOutputLines(carry, chunk);
      carry = parsed.carry;
      lines.push(...parsed.lines);
    }
    const trace: Record<string, number> = {};
    for (const line of lines) {
      testing.collectStartupTrace(line, trace);
    }

    expect(carry).toBe("");
    expect(lines.map(testing.classifyGatewayReadyLog)).toContain("gateway-ready");
    expect(trace).toMatchObject({
      "sidecars.ready": 2,
      "sidecars.ready.heapUsedMb": 12,
      "sidecars.ready.total": 7.5,
    });
  });

  it("summarizes split ready log timings without the ambiguous readyLogMs field", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        completionMs: 50,
        cpuCoreRatio: null,
        cpuMs: null,
        exitCode: null,
        firstOutputMs: 1,
        gatewayReadyLogLine: "[gateway] ready",
        gatewayReadyLogMs: 40,
        healthz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: 20,
          ms: 20,
          status: 200,
          transitions: [],
        },
        httpListenLogLine: "[gateway] http server listening (0 plugins)",
        httpListenLogMs: 10,
        maxRssMb: null,
        outputTail: "",
        readyz: {
          firstErrorKind: "http-503",
          firstRecoveryMs: 30,
          ms: 30,
          status: 200,
          transitions: [],
        },
        signal: null,
        startupTrace: {},
      },
    ]);

    expect(result.summary.completionMs?.p50).toBe(50);
    expect(result.summary.httpListenLogMs?.p50).toBe(10);
    expect(result.summary.gatewayReadyLogMs?.p50).toBe(40);
    expect("readyLogMs" in result.summary).toBe(false);
  });

  it("flags samples that never produced readiness or process metrics", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        completionMs: null,
        cpuCoreRatio: null,
        cpuMs: null,
        exitCode: 1,
        firstOutputMs: 5,
        gatewayReadyLogLine: null,
        gatewayReadyLogMs: null,
        healthz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: null,
          ms: null,
          status: null,
          transitions: [],
        },
        httpListenLogLine: null,
        httpListenLogMs: null,
        maxRssMb: null,
        outputTail: "Error: Cannot find module 'dist/entry.js'",
        readyz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: null,
          ms: null,
          status: null,
          transitions: [],
        },
        signal: null,
        startupTrace: {},
      },
    ]);

    expect(testing.collectResultFailures([result], { processMetricsRequired: true })).toEqual([
      {
        id: "demo",
        reason: "missing /healthz, /readyz, completion, cpu, rss",
        sampleIndex: 1,
      },
    ]);
  });

  it("flags samples that become ready and then exit nonzero", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        completionMs: 20,
        cpuCoreRatio: 0.5,
        cpuMs: 100,
        exitedBeforeTeardown: true,
        exitCode: 1,
        firstOutputMs: 1,
        gatewayReadyLogLine: "[gateway] ready",
        gatewayReadyLogMs: 20,
        healthz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: 10,
          ms: 10,
          status: 200,
          transitions: [],
        },
        httpListenLogLine: "[gateway] http server listening (0 plugins)",
        httpListenLogMs: 5,
        maxRssMb: 120,
        outputTail: "ready\\nError: startup sidecar crashed",
        readyz: {
          firstErrorKind: "http-503",
          firstRecoveryMs: 18,
          ms: 18,
          status: 200,
          transitions: [],
        },
        signal: null,
        startupTrace: {},
      },
    ]);

    expect(testing.collectResultFailures([result], { processMetricsRequired: true })).toEqual([
      {
        id: "demo",
        reason: "child exited 1",
        sampleIndex: 1,
      },
    ]);
  });

  it("does not flag nonzero exits from intentional teardown", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        completionMs: 20,
        cpuCoreRatio: 0.5,
        cpuMs: 100,
        exitedBeforeTeardown: false,
        exitCode: 1,
        firstOutputMs: 1,
        gatewayReadyLogLine: "[gateway] ready",
        gatewayReadyLogMs: 20,
        healthz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: 10,
          ms: 10,
          status: 200,
          transitions: [],
        },
        httpListenLogLine: "[gateway] http server listening (0 plugins)",
        httpListenLogMs: 5,
        maxRssMb: 120,
        outputTail: "",
        readyz: {
          firstErrorKind: "http-503",
          firstRecoveryMs: 18,
          ms: 18,
          status: 200,
          transitions: [],
        },
        signal: null,
        startupTrace: {},
      },
    ]);

    expect(testing.collectResultFailures([result], { processMetricsRequired: true })).toEqual([]);
  });

  it("enforces the combined incident readiness budgets", () => {
    const result = testing.summarizeCase({ config: {}, id: "incidentCombined", name: "incident" }, [
      {
        completionMs: 60_000,
        cpuCoreRatio: 0.5,
        cpuMs: 100,
        exitCode: 0,
        firstOutputMs: 1,
        gatewayReadyLogLine: "[gateway] ready",
        gatewayReadyLogMs: 60_000,
        healthz: {
          firstErrorKind: null,
          firstRecoveryMs: 30_000,
          ms: 30_000,
          status: 200,
          transitions: [],
        },
        httpListenLogLine: "[gateway] http server listening (0 plugins)",
        httpListenLogMs: 5,
        maxRssMb: 120,
        outputTail: "",
        readyz: {
          firstErrorKind: null,
          firstRecoveryMs: 60_000,
          ms: 60_000,
          status: 200,
          transitions: [],
        },
        signal: null,
        startupTrace: {},
      },
    ]);

    expect(testing.collectResultFailures([result], { processMetricsRequired: true })).toEqual([
      {
        id: "incidentCombined",
        reason: "/healthz p95 30000.0ms must be under 30000.0ms",
        sampleIndex: 0,
      },
      {
        id: "incidentCombined",
        reason: "/readyz p95 60000.0ms must be under 60000.0ms",
        sampleIndex: 0,
      },
    ]);
  });

  it("flags samples that become ready and then die from a signal", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        completionMs: 20,
        cpuCoreRatio: 0.5,
        cpuMs: 100,
        exitedBeforeTeardown: true,
        exitCode: null,
        firstOutputMs: 1,
        gatewayReadyLogLine: "[gateway] ready",
        gatewayReadyLogMs: 20,
        healthz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: 10,
          ms: 10,
          status: 200,
          transitions: [],
        },
        httpListenLogLine: "[gateway] http server listening (0 plugins)",
        httpListenLogMs: 5,
        maxRssMb: 120,
        outputTail: "ready\\nsegmentation fault",
        readyz: {
          firstErrorKind: "http-503",
          firstRecoveryMs: 18,
          ms: 18,
          status: 200,
          transitions: [],
        },
        signal: "SIGSEGV",
        startupTrace: {},
      },
    ]);

    expect(testing.collectResultFailures([result], { processMetricsRequired: true })).toEqual([
      {
        id: "demo",
        reason: "child exited by SIGSEGV",
        sampleIndex: 1,
      },
    ]);
  });

  registerStopChildBehaviorTests({
    stopChild: testing.stopChild,
    queuedExitCode: 7,
  });

  it("collects Count-suffixed startup trace metrics", () => {
    const startupTrace: Record<string, number> = {};

    testing.collectStartupTrace(
      "[gateway] startup trace: sidecars.acp.runtime-ready ready=1 readyCount=1 backend=acpx",
      startupTrace,
    );

    expect(startupTrace["sidecars.acp.runtime-ready.ready"]).toBeUndefined();
    expect(startupTrace["sidecars.acp.runtime-ready.readyCount"]).toBe(1);
  });

  it("collects prepared runtime grouping counts", () => {
    const startupTrace: Record<string, number> = {};

    testing.collectStartupTrace(
      "[gateway] startup trace: sidecars.model-runtime-build agentCount=12 workspaceGroupCount=2 configuredFactsGroupCount=2 catalogSourceCount=0 credentialGroupCount=1 catalogGroupCount=0 runtimeRegistryCount=2 sourceConcurrencyLimitCount=2 fullCatalogConcurrencyLimitCount=1",
      startupTrace,
    );

    expect(startupTrace["sidecars.model-runtime-build.agentCount"]).toBe(12);
    expect(startupTrace["sidecars.model-runtime-build.configuredFactsGroupCount"]).toBe(2);
    expect(startupTrace["sidecars.model-runtime-build.catalogGroupCount"]).toBe(0);
    expect(startupTrace["sidecars.model-runtime-build.runtimeRegistryCount"]).toBe(2);
  });

  it("uses the recorded trace total for completion timing", async () => {
    const startedAt = performance.now();
    const completionMs = await testing.waitForStartupTracePhase({
      deadlineAt: startedAt + 1_000,
      isDone: () => false,
      phase: "sidecars.ready",
      startupTrace: {
        "sidecars.ready": 20,
        "sidecars.ready.total": 50,
      },
    });

    expect(completionMs).toBe(50);
  });

  it("keeps counts and memory metrics out of the slow-duration ranking", () => {
    expect(isStartupTraceDuration("plugins.runtime-post-bind")).toBe(true);
    expect(isStartupTraceDuration("plugins.gateway-load.loadMs")).toBe(true);
    expect(isStartupTraceDuration("ready.eventLoopMax")).toBe(true);
    expect(isStartupTraceDuration("plugins.runtime-post-bind.gatewayMethodCount")).toBe(false);
    expect(isStartupTraceDuration("memory.ready.rssMb")).toBe(false);
    expect(isStartupTraceDuration("ready.total")).toBe(false);
  });

  it("records probe state transitions, first error kind, and first recovery", async () => {
    let calls = 0;
    const { port, server } = await listenOnLoopback((_req, res) => {
      calls += 1;
      res.statusCode = calls === 1 ? 503 : 200;
      res.end("ok");
    });
    try {
      const startAt = performance.now();
      const result = await testing.waitForProbe({
        deadlineAt: startAt + 1_000,
        path: "/readyz",
        port,
        startAt,
      });

      expect(result.status).toBe(200);
      expect(result.ms).toEqual(expect.any(Number));
      expect(result.firstErrorKind).toBe("http-503");
      expect(result.firstRecoveryMs).toEqual(expect.any(Number));
      expect(result.transitions.map((transition) => transition.status)).toEqual([503, 200]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("writes 50-plugin fixtures as a parent load path with explicit startup activation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      const configPath = testing.writeConfig(root, {
        config: {},
        id: "fiftyPlugins",
        name: "gateway, 50 manifest plugins",
        pluginActivationOnStartup: true,
        pluginCount: 2,
      });
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        plugins?: { allow?: string[]; load?: { paths?: string[] } };
      };

      expect(config.plugins?.load?.paths).toEqual([path.join(root, "plugins")]);
      expect(config.plugins?.allow).toEqual(["bench-plugin-01", "bench-plugin-02"]);
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", "bench-plugin-01", "openclaw.plugin.json"),
          "utf8",
        ),
      ) as { activation?: { onStartup?: boolean } };
      expect(manifest.activation?.onStartup).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a bounded incident fixture before the startup timer begins", async () => {
    const root = tempDirs.make("openclaw-incident-bench-test-");
    await testing.writeIncidentFixture(root, {
      kind: "combined",
      auditRowCount: 2_000,
      workspaceFileBytes: 32,
      workspaceFileCount: 6,
    });
    const { DatabaseSync } = await import("node:sqlite");
    const statePath = path.join(root, "state", "state", "openclaw.sqlite");
    const state = new DatabaseSync(statePath, { readOnly: true });
    try {
      expect(state.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
        count: 1_000,
      });
      const freelist = state.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
      expect(freelist.freelist_count).toBeGreaterThan(0);
      expect(
        state.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({
        app_version: null,
      });
    } finally {
      state.close();
    }
    for (let index = 1; index <= 8; index += 1) {
      const agent = new DatabaseSync(
        path.join(
          root,
          "state",
          "agents",
          `incident-agent-${String(index).padStart(2, "0")}`,
          "agent",
          "openclaw-agent.sqlite",
        ),
        { readOnly: true },
      );
      try {
        expect(
          agent.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({
          app_version: null,
        });
      } finally {
        agent.close();
      }
    }
    expect(
      fs.statSync(
        path.join(
          root,
          "workspaces",
          "agent-01",
          "incident-artifacts",
          "batch-000",
          "artifact-000000.bin",
        ),
      ).size,
    ).toBe(32);
  });

  it("removes the benchmark fixture when a sample fails", async () => {
    let fixtureRoot = "";

    await expect(
      testing.withGatewayBenchRoot(async (root) => {
        fixtureRoot = root;
        fs.writeFileSync(path.join(root, "fixture"), "test");
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");

    expect(fs.existsSync(fixtureRoot)).toBe(false);
  });

  it("builds a deterministic prepared-runtime catalog stall case", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      const benchCase = testing.parseOptions(["--case", "preparedRuntimeCatalogStall"]).cases[0];
      if (!benchCase) {
        throw new Error("expected prepared runtime catalog stall case");
      }
      const configPath = testing.writeConfig(root, benchCase);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        plugins?: { allow?: string[]; load?: { paths?: string[] } };
      };
      const pluginId = config.plugins?.allow?.[0];
      expect(pluginId).toBe("bench-plugin-01");
      const pluginDir = path.join(root, "plugins", pluginId ?? "missing");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(pluginDir, "openclaw.plugin.json"), "utf8"),
      ) as { providers?: string[] };
      const source = fs.readFileSync(path.join(pluginDir, "index.cjs"), "utf8");

      expect(manifest.providers).toEqual(["bench-catalog-stall"]);
      expect(source).toContain("api.registerProvider");
      expect(source).toContain("Date.now() + 2000");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a valid large plugin-model startup case", () => {
    const root = tempDirs.make("openclaw-large-plugin-model-bench-test-");
    const benchCase = testing.parseOptions(["--case", "largePluginModelConfig"]).cases[0];
    if (!benchCase) {
      throw new Error("expected large plugin-model benchmark case");
    }
    const configPath = testing.writeConfig(root, benchCase);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenClawConfig;
    const entries = Object.values(config.agents?.entries ?? {});
    const modelRefs = collectConfiguredModelRefs(config, { includeChannelModelOverrides: false });

    expect(benchCase.completionTracePhase).toBe("config.snapshot.auto-enable");
    expect(validateConfigObject(config).ok).toBe(true);
    expect(entries).toHaveLength(256);
    expect(modelRefs).toHaveLength(256 * 58);
    expect(new Set(modelRefs.map(({ value }) => value.slice(0, value.indexOf("/"))))).toEqual(
      new Set(["openai", "google", "minimax"]),
    );
    expect(config.plugins?.allow).toEqual(["openai", "google", "minimax"]);
  });

  it("builds prepared-runtime scale cases with shared and distinct workspaces", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      const benchCase = testing.parseOptions(["--case", "preparedRuntimeScaleMany"]).cases[0];
      if (!benchCase) {
        throw new Error("expected prepared runtime scale case");
      }
      const configPath = testing.writeConfig(root, benchCase);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        agents?: { list?: Array<{ id: string; workspace: string }> };
        plugins?: { allow?: string[] };
      };
      const agents = config.agents?.list ?? [];
      expect(agents).toHaveLength(12);
      expect(new Set(agents.slice(0, 11).map((agent) => agent.workspace)).size).toBe(1);
      expect(agents[11]?.workspace).not.toBe(agents[0]?.workspace);
      const pluginId = config.plugins?.allow?.[0];
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", pluginId ?? "missing", "openclaw.plugin.json"),
          "utf8",
        ),
      ) as { modelCatalog?: unknown; providerCatalogEntry?: string; providers?: string[] };
      expect(manifest.providers).toEqual(["bench-catalog-stall"]);
      expect(manifest.providerCatalogEntry).toBe("./provider-discovery.cjs");
      expect(manifest.modelCatalog).toBeUndefined();
      expect(
        fs.readFileSync(
          path.join(root, "plugins", "bench-plugin-01", "provider-discovery.cjs"),
          "utf8",
        ),
      ).toContain("preparedRuntimeStaticCatalogCallCount");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps startup-lazy plugin fixtures opted out of startup activation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      testing.writeConfig(root, {
        config: {},
        id: "fiftyStartupLazyPlugins",
        name: "gateway, 50 startup-lazy manifest plugins",
        pluginActivationOnStartup: false,
        pluginCount: 1,
      });
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", "bench-plugin-01", "openclaw.plugin.json"),
          "utf8",
        ),
      ) as { activation?: { onStartup?: boolean } };
      expect(manifest.activation?.onStartup).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
