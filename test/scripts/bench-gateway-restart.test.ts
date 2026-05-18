import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { __testing } from "../../scripts/bench-gateway-restart.ts";

describe("gateway restart benchmark script", () => {
  it("prints help without running benchmark cases", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-gateway-restart.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw Gateway restart benchmark");
    expect(result.stdout).toContain("--restarts <n>");
    expect(result.stdout).toContain("--post-ready-delay-ms <ms>");
    expect(result.stdout).toContain("skipChannels (gateway restart, skip channels)");
    expect(result.stdout).toContain(
      "skipChannelsNoAcpxProbe (gateway restart, skip channels, ACPX startup probe off)",
    );
    expect(result.stdout).not.toContain("[gateway-restart-bench]");
    expect(result.stderr).toBe("");
  });

  it("rejects ambiguous benchmark CLI values before spawning Node", () => {
    expect(__testing.parsePositiveInt("5", 1, "--restarts")).toBe(5);
    expect(__testing.parseNonNegativeInt("0", 1, "--warmup")).toBe(0);
    expect(() => __testing.parsePositiveInt("2abc", 1, "--restarts")).toThrow(
      /--restarts must be an integer/u,
    );
    expect(() => __testing.resolveEntry("--inspect")).toThrow(/must be a file path/u);
  });

  it("guards the SIGUSR1 restart benchmark on Windows", () => {
    expect(() => __testing.ensureSupportedRestartPlatform("linux")).not.toThrow();
    expect(() => __testing.ensureSupportedRestartPlatform("darwin")).not.toThrow();
    expect(() => __testing.ensureSupportedRestartPlatform("win32")).toThrow(
      /not supported on Windows/u,
    );
  });

  it("buffers child output lines split across chunks", () => {
    const first = __testing.collectOutputLines("", "[gateway] restart trace: restart.ready 12");
    expect(first.lines).toEqual([]);

    const second = __testing.collectOutputLines(first.carry, ".5ms total=45.0ms\r");
    expect(second.lines).toEqual([]);

    const third = __testing.collectOutputLines(second.carry, "\n[gateway] ready\npartial");
    expect(third.lines).toEqual([
      "[gateway] restart trace: restart.ready 12.5ms total=45.0ms",
      "[gateway] ready",
    ]);
    expect(third.carry).toBe("partial");
  });

  it("flushes buffered restart output before classifying an iteration", () => {
    const iteration = __testing.createRestartIteration(1);
    iteration.healthz = {
      downtimeMs: 10,
      firstErrorKind: "econnreset",
      firstRecoveryMs: 30,
      ms: 30,
      status: 200,
      transitions: [],
      unavailableMs: 20,
    };
    iteration.readyz = {
      downtimeMs: 12,
      firstErrorKind: "http-503",
      firstRecoveryMs: 42,
      ms: 42,
      status: 200,
      transitions: [],
      unavailableMs: 30,
    };

    const failure = __testing.finalizeRestartIteration(iteration, false, () => {
      iteration.gatewayReadyLogLine = "[gateway] ready";
      iteration.gatewayReadyLogMs = 45;
      iteration.restartTrace["restart.ready.total"] = 50;
    });

    expect(failure).toBeNull();
  });

  it("preserves buffered child output carry until stream end", () => {
    const buffers = {
      stderr: "[gateway] ready",
      stdout: "[gateway] restart trace: restart.ready 12.5ms total=45.0ms",
    };
    const lines: string[] = [];

    __testing.flushOutputLineBuffers(buffers, (line) => lines.push(line), 1);

    expect(lines).toEqual([]);
    expect(buffers).toEqual({
      stderr: "[gateway] ready",
      stdout: "[gateway] restart trace: restart.ready 12.5ms total=45.0ms",
    });
  });

  it("flushes buffered child output carry at stream end", () => {
    const buffers = {
      stderr: "[gateway] ready",
      stdout: "[gateway] restart trace: restart.ready 12.5ms total=45.0ms",
    };
    const lines: string[] = [];

    __testing.flushOutputLineBuffers(buffers, (line) => lines.push(line), 1, {
      flushPartial: true,
    });

    expect(lines).toEqual([
      "[gateway] restart trace: restart.ready 12.5ms total=45.0ms",
      "[gateway] ready",
    ]);
    expect(buffers).toEqual({ stderr: "", stdout: "" });
  });

  it("counts only numeric descriptors from lsof output", () => {
    expect(
      __testing.countLsofFileDescriptors(`COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    1234 user  cwd    DIR    1,2      128    2 /tmp
node    1234 user  txt    REG    1,2    12345    3 /usr/bin/node
node    1234 user  mem    REG    1,2    12345    4 /usr/lib/lib.dylib
node    1234 user    0r   CHR    3,2      0t0    5 /dev/null
node    1234 user    1w   REG    1,2      123    6 /tmp/stdout
node    1234 user   12u  IPv4    0t0      TCP localhost:1234
`),
    ).toBe(3);
  });

  it("enables both startup and restart trace in the child gateway environment", () => {
    const env = __testing.sanitizedEnv("/tmp/openclaw-bench", "/tmp/openclaw-bench/config.json", {
      config: {},
      id: "skipChannels",
      name: "gateway restart, skip channels",
    });

    expect(env.OPENCLAW_GATEWAY_STARTUP_TRACE).toBe("1");
    expect(env.OPENCLAW_GATEWAY_RESTART_TRACE).toBe("1");
    expect(env.OPENCLAW_NO_RESPAWN).toBe("1");
    expect(env.OPENCLAW_LOCAL_CHECK).toBeUndefined();
  });

  it("can pin ACPX startup probe policy per benchmark case", () => {
    const probeOffEnv = __testing.sanitizedEnv(
      "/tmp/openclaw-bench",
      "/tmp/openclaw-bench/config.json",
      {
        config: {},
        env: { OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "0" },
        id: "skipChannelsNoAcpxProbe",
        name: "gateway restart, skip channels, ACPX startup probe off",
      },
    );

    expect(probeOffEnv.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE).toBe("0");
  });

  it("parses restart trace metrics including resource Count fields", () => {
    const restartTrace: Record<string, number> = {};

    __testing.collectTraceLine(
      "[gateway] restart trace: restart.ready 12.5ms total=45.0ms rssMb=200.5 heapUsedMb=80.1 activeHandlesCount=12 activeTimersCount=2 indexPlugins=50",
      "restart trace",
      restartTrace,
    );

    expect(restartTrace["restart.ready"]).toBe(12.5);
    expect(restartTrace["restart.ready.total"]).toBe(45);
    expect(restartTrace["restart.ready.rssMb"]).toBe(200.5);
    expect(restartTrace["restart.ready.heapUsedMb"]).toBe(80.1);
    expect(restartTrace["restart.ready.activeHandlesCount"]).toBe(12);
    expect(restartTrace["restart.ready.activeTimersCount"]).toBe(2);
    expect(restartTrace["restart.ready.indexPlugins"]).toBeUndefined();
  });

  it("requires initial ready logs before restart attribution", () => {
    expect(
      __testing.hasInitialReadyLogs({
        initialGatewayReadyLogMs: 20,
        initialHttpListenLogMs: 10,
      }),
    ).toBe(true);
    expect(
      __testing.hasInitialReadyLogs({
        initialGatewayReadyLogMs: 20,
        initialHttpListenLogMs: null,
      }),
    ).toBe(false);
  });

  it("reports deadline expiry separately from child exit", () => {
    expect(__testing.resolveRestartDeadlineFailure(false)).toBe("restart_deadline_timeout");
    expect(__testing.resolveRestartDeadlineFailure(true)).toBe("restart_child_exited");
  });

  it("does not fail successful restarts when probes miss the unavailable window", () => {
    const iteration = __testing.createRestartIteration(1);
    iteration.gatewayReadyLogMs = 40;
    iteration.gatewayReadyLogLine = "[gateway] ready";
    iteration.healthz = {
      downtimeMs: null,
      firstErrorKind: null,
      firstRecoveryMs: null,
      ms: 24,
      status: 200,
      transitions: [],
      unavailableMs: null,
    };
    iteration.readyz = {
      downtimeMs: null,
      firstErrorKind: null,
      firstRecoveryMs: null,
      ms: 26,
      status: 200,
      transitions: [],
      unavailableMs: null,
    };
    iteration.restartTrace = { "restart.ready.total": 35 };

    expect(__testing.finalizeRestartIteration(iteration, false, () => {})).toBeNull();
  });

  it("summarizes failure rate, restart.ready totals, and resource slope", () => {
    const result = __testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        childExitCode: null,
        childSignal: "SIGTERM",
        events: [],
        failureCode: null,
        firstOutputMs: 1,
        initialGatewayReadyLogLine: "[gateway] ready",
        initialGatewayReadyLogMs: 20,
        initialHealthz: {
          downtimeMs: null,
          firstErrorKind: "econnrefused",
          firstRecoveryMs: 10,
          ms: 10,
          status: 200,
          transitions: [],
          unavailableMs: null,
        },
        initialHttpListenLogLine: "[gateway] http server listening (0 plugins)",
        initialHttpListenLogMs: 9,
        initialReadyz: {
          downtimeMs: null,
          firstErrorKind: "http-503",
          firstRecoveryMs: 12,
          ms: 12,
          status: 200,
          transitions: [],
          unavailableMs: null,
        },
        initialStartupTrace: {},
        iterations: [
          {
            cpuCoreRatio: null,
            cpuMs: null,
            failureCode: null,
            gatewayReadyLogLine: "[gateway] ready",
            gatewayReadyLogMs: 40,
            healthz: {
              downtimeMs: 10,
              firstErrorKind: "econnreset",
              firstRecoveryMs: 30,
              ms: 30,
              status: 200,
              transitions: [],
              unavailableMs: 20,
            },
            httpListenLogLine: "[gateway] http server listening (0 plugins)",
            httpListenLogMs: 20,
            index: 1,
            readyz: {
              downtimeMs: 12,
              firstErrorKind: "http-503",
              firstRecoveryMs: 42,
              ms: 42,
              status: 200,
              transitions: [],
              unavailableMs: 30,
            },
            resourceSnapshots: [],
            restartTrace: {
              "restart.ready": 12,
              "restart.ready.total": 50,
              "restart.ready.heapUsedMb": 100,
              "restart.ready.rssMb": 200,
            },
            signalSentMs: 100,
            startupTrace: {},
          },
          {
            cpuCoreRatio: null,
            cpuMs: null,
            failureCode: "trace_missing",
            gatewayReadyLogLine: "[gateway] ready",
            gatewayReadyLogMs: 45,
            healthz: {
              downtimeMs: 10,
              firstErrorKind: "econnreset",
              firstRecoveryMs: 35,
              ms: 35,
              status: 200,
              transitions: [],
              unavailableMs: 25,
            },
            httpListenLogLine: "[gateway] http server listening (0 plugins)",
            httpListenLogMs: 25,
            index: 2,
            readyz: {
              downtimeMs: 15,
              firstErrorKind: "http-503",
              firstRecoveryMs: 50,
              ms: 50,
              status: 200,
              transitions: [],
              unavailableMs: 35,
            },
            resourceSnapshots: [],
            restartTrace: {
              "restart.ready.heapUsedMb": 104,
              "restart.ready.rssMb": 206,
            },
            signalSentMs: 200,
            startupTrace: {},
          },
        ],
        maxRssMb: 220,
        outputTail: "",
        resourceSlope: {
          activeHandlesCountPerRestart: null,
          activeRequestsCountPerRestart: null,
          activeTimersCountPerRestart: null,
          fdCountPerRestart: null,
          heapUsedMbPerRestart: 4,
          rssMbPerRestart: 6,
        },
      },
    ]);

    expect(result.summary.failureRate).toBe(0.5);
    expect(result.summary.firstFailureCode).toBe("trace_missing");
    expect(result.summary.restartReadyTotalMs?.p50).toBe(50);
    expect(result.summary.resourceSlope.heapUsedMbPerRestart?.p50).toBe(4);
    expect(result.summary.resourceSlope.rssMbPerRestart?.p50).toBe(6);
  });

  it("counts sample failures that happen before restart iterations", () => {
    const result = __testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        childExitCode: null,
        childSignal: null,
        events: [],
        failureCode: "initial_readyz_timeout",
        firstOutputMs: 1,
        initialGatewayReadyLogLine: "[gateway] ready",
        initialGatewayReadyLogMs: 20,
        initialHealthz: {
          downtimeMs: null,
          firstErrorKind: null,
          firstRecoveryMs: null,
          ms: 10,
          status: 200,
          transitions: [],
          unavailableMs: null,
        },
        initialHttpListenLogLine: "[gateway] http server listening (0 plugins)",
        initialHttpListenLogMs: 9,
        initialReadyz: {
          downtimeMs: null,
          firstErrorKind: "http-503",
          firstRecoveryMs: null,
          ms: null,
          status: 503,
          transitions: [],
          unavailableMs: null,
        },
        initialStartupTrace: {},
        iterations: [],
        maxRssMb: 220,
        outputTail: "",
        resourceSlope: {
          activeHandlesCountPerRestart: null,
          activeRequestsCountPerRestart: null,
          activeTimersCountPerRestart: null,
          fdCountPerRestart: null,
          heapUsedMbPerRestart: null,
          rssMbPerRestart: null,
        },
      },
    ]);

    expect(result.summary.failureRate).toBe(1);
    expect(result.summary.firstFailureCode).toBe("initial_readyz_timeout");
  });

  it("writes restart intent files for the target gateway pid", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-bench-test-"));
    try {
      const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };

      expect(__testing.writeRestartIntent(env, 12345, "gateway-restart-bench")).toBe(true);
      const raw = fs.readFileSync(path.join(root, "state", "gateway-restart-intent.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        kind?: unknown;
        pid?: unknown;
        reason?: unknown;
      };

      expect(parsed.kind).toBe("gateway-restart");
      expect(parsed.pid).toBe(12345);
      expect(parsed.reason).toBe("gateway-restart-bench");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("finishes restart probes when ready arrives without an unavailable window", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      const sampleStartAt = performance.now();
      const result = await __testing.waitForRestartProbe({
        deadlineAt: sampleStartAt + 2_000,
        events: [],
        isDone: () => performance.now() - sampleStartAt > 60,
        iteration: 1,
        path: "/readyz",
        port: address.port,
        sampleStartAt,
        signalSentAt: sampleStartAt,
      });

      expect(result.status).toBe(200);
      expect(result.ms).not.toBeNull();
      expect(result.ms ?? 0).toBeLessThan(1_000);
      expect(result.downtimeMs).toBeNull();
      expect(result.unavailableMs).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps restart probes running until HTTP recovers after an unavailable window", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.statusCode = requests === 1 ? 503 : 200;
      res.end(requests === 1 ? "warming" : "ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      const sampleStartAt = performance.now();
      const result = await __testing.waitForRestartProbe({
        deadlineAt: sampleStartAt + 2_000,
        events: [],
        isDone: () => requests >= 1,
        iteration: 1,
        path: "/readyz",
        port: address.port,
        sampleStartAt,
        signalSentAt: sampleStartAt,
      });

      expect(result.status).toBe(200);
      expect(result.ms).not.toBeNull();
      expect(result.unavailableMs).not.toBeNull();
      expect(result.downtimeMs).not.toBeNull();
      expect(requests).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("writes plugin fixtures as a parent load path with explicit startup activation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-bench-config-test-"));
    try {
      const configPath = __testing.writeConfig(root, {
        config: {},
        id: "fiftyPlugins",
        name: "gateway restart, 50 manifest plugins",
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
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
