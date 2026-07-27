// Bench Gateway Startup tests cover bench gateway startup script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type RequestListener } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-gateway-startup.ts";
import { isStartupTraceDuration } from "../../scripts/lib/gateway-startup-trace-ranking.js";
import { registerStopChildBehaviorTests } from "./bench-gateway-child-test-support.js";

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
    expect(helpResult.stdout).toContain("default (gateway default)");
    expect(helpResult.stdout).not.toContain("[gateway-startup-bench]");
    expect(helpResult.stderr).toBe("");
  });

  it("rejects ambiguous benchmark CLI values before spawning Node", () => {
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
    expect(testing.parsePositiveInt("5", 1, "--runs")).toBe(5);
    expect(testing.parseNonNegativeInt("0", 1, "--warmup")).toBe(0);
    expect(
      testing.parseOptions([
        "--case",
        "default",
        "--output",
        "startup.json",
        "--json",
        "--runs",
        "2",
      ]),
    ).toMatchObject({
      cases: [{ id: "default" }],
      json: true,
      output: "startup.json",
      runs: 2,
    });
    expect(() => testing.parsePositiveInt("2abc", 1, "--runs")).toThrow(
      /--runs must be an integer/u,
    );
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
    expect(() => testing.resolveEntry("--inspect")).toThrow(/must be a file path/u);
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

  it("rejects malformed ps RSS samples", () => {
    expect(testing.parseProcessRssKb("2048\n")).toBe(2048);
    expect(testing.parseProcessRssKb("2048kb\n")).toBeNull();
    expect(testing.parseProcessRssKb("2048 4096\n")).toBeNull();
    expect(testing.parseProcessRssKb("0\n")).toBeNull();
    expect(testing.parseProcessRssKb("")).toBeNull();
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

  it("summarizes split ready log timings without the ambiguous readyLogMs field", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
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

    expect(result.summary.httpListenLogMs?.p50).toBe(10);
    expect(result.summary.gatewayReadyLogMs?.p50).toBe(40);
    expect("readyLogMs" in result.summary).toBe(false);
  });

  it("flags samples that never produced readiness or process metrics", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
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
        reason: "missing /healthz, /readyz, cpu, rss",
        sampleIndex: 1,
      },
    ]);
  });

  it("flags samples that become ready and then exit nonzero", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
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

  it("flags samples that become ready and then die from a signal", () => {
    const result = testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
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
