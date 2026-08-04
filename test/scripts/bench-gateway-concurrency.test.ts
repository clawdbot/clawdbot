// Gateway concurrency benchmark tests cover CLI parsing and bounded percentile summaries.
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createRawServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-gateway-concurrency.ts";

describe("gateway concurrency benchmark script", () => {
  it("parses benchmark controls without booting a gateway", () => {
    expect(
      testing.parseOptions([
        "--concurrency",
        "12",
        "--runs",
        "2",
        "--warmup",
        "0",
        "--cadence-ms",
        "50",
        "--timeout-ms",
        "90000",
        "--output",
        "concurrency.json",
        "--json",
      ]),
    ).toMatchObject({
      cadenceMs: 50,
      concurrency: 12,
      json: true,
      output: "concurrency.json",
      runs: 2,
      timeoutMs: 90_000,
      warmup: 0,
    });
    expect(() => testing.parseOptions(["--concurrency", "65"])).toThrow(
      "--concurrency must be at most 64",
    );
    expect(() => testing.parseOptions(["--runs", "2", "--runs", "3"])).toThrow(
      "--runs was provided more than once",
    );
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("reports p50, p95, p99, and max with nearest-rank percentiles", () => {
    expect(testing.summarizeNumbers([100, 1, 4, 2, 3])).toEqual({
      count: 5,
      max: 100,
      p50: 3,
      p95: 100,
      p99: 100,
    });
    expect(testing.summarizeNumbers([])).toBeNull();
  });

  it("bounds an accepted turn wait by the benchmark deadline", async () => {
    const calls: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
    const rpc = async <T>(method: string, params: unknown, timeoutMs?: number): Promise<T> => {
      calls.push({ method, params, timeoutMs });
      return (
        method === "agent" ? { runId: "run-1", status: "accepted" } : { status: "timeout" }
      ) as T;
    };

    await expect(testing.runTurn(rpc, 0, performance.now() + 2_000)).rejects.toThrow(
      "agent 1 did not complete",
    );

    const wait = calls.find((call) => call.method === "agent.wait");
    expect(wait?.params).toMatchObject({ runId: "run-1" });
    const serverTimeoutMs = (wait?.params as { timeoutMs?: unknown } | undefined)?.timeoutMs;
    expect(serverTimeoutMs).toBe(0);
    expect(wait?.timeoutMs).toEqual(expect.any(Number));
    expect(Number.isInteger(wait?.timeoutMs)).toBe(true);
    expect(wait?.timeoutMs).toBeGreaterThan(serverTimeoutMs as number);
    expect(wait?.timeoutMs).toBeLessThanOrEqual(2_000);
  });

  it("gives every gateway sample a fresh pre-warmup timeout budget", async () => {
    const deadlines: number[] = [];
    const sample = {
      controlUi: [],
      durationMs: 10,
      probeWarmup: { durationMs: 2, samples: [] },
      readyz: [],
      sessionsList: [],
      turnCount: 8,
      turnsDurationMs: 5,
    };

    const runs = await testing.runBenchmarkSamples({
      now: (() => {
        const values = [1_000, 9_000];
        return () => values.shift() ?? 9_000;
      })(),
      options: testing.parseOptions(["--runs", "1", "--warmup", "1", "--timeout-ms", "5000"]),
      runSample: async ({ deadlineAt }) => {
        deadlines.push(deadlineAt);
        return sample;
      },
    });

    expect(deadlines).toEqual([6_000, 14_000]);
    expect(runs).toEqual([sample]);
  });

  it("preserves HTTP and RPC failures in baseline probe diagnostics", async () => {
    const probeOrder: string[] = [];
    const server = createHttpServer((req, res) => {
      probeOrder.push(req.url ?? "missing-url");
      res.statusCode = req.url === "/readyz" ? 503 : 200;
      res.end(req.url === "/readyz" ? '{"status":"starting"}' : "not html");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected HTTP test server address");
    }
    try {
      const sample = await testing.sampleGateway({
        deadlineAt: performance.now() + 5_000,
        port: address.port,
        rpc: async () => {
          probeOrder.push("sessions.list");
          throw new Error("sessions.list failed: unauthorized");
        },
        runStartedAt: performance.now(),
        serial: true,
      });

      expect(probeOrder).toEqual(["/readyz", "/", "sessions.list"]);
      expect(sample.readyz).toMatchObject({ error: null, ok: false, status: 503 });
      expect(sample.controlUi).toMatchObject({
        error: "response body did not contain <html",
        ok: false,
        status: 200,
      });
      expect(sample.sessionsList).toMatchObject({
        error: "sessions.list failed: unauthorized",
        ok: false,
      });
      const failure = testing.formatRunFailure(
        new Error(testing.formatProbeFailure(sample)),
        {
          readOutput: () => "gateway output",
          readStderrTail: () => testing.tailLines("old\nfirst retained\nlast retained\n", 2),
        },
        { readOutput: () => "mock output" },
      );
      expect(failure).toMatch(
        /readyz: ok=false status=503 latencyMs=\d+\.\d error=none\n  sessionsList: ok=false status=n\/a latencyMs=\d+\.\d error="sessions\.list failed: unauthorized"\n  controlUi: ok=false status=200 latencyMs=\d+\.\d error="response body did not contain <html"/u,
      );
      expect(failure).toContain("gateway stderr tail:\nfirst retained\nlast retained");
      expect(failure).not.toContain("old");

      const healthySlow = {
        controlUi: { ...sample.controlUi, error: null, latencyMs: 200, ok: true },
        readyz: { ...sample.readyz, latencyMs: 200, ok: true, status: 200 },
        sessionsList: { ...sample.sessionsList, error: null, latencyMs: 200, ok: true },
      };
      const healthyFast = {
        controlUi: { ...healthySlow.controlUi, latencyMs: 10 },
        readyz: { ...healthySlow.readyz, latencyMs: 10 },
        sessionsList: { ...healthySlow.sessionsList, latencyMs: 10 },
      };
      const samples = [sample, healthySlow, healthyFast];
      const warmed = await testing.warmGatewayProbes({
        deadlineAt: performance.now() + 5_000,
        retryDelayMs: 0,
        sample: async () => samples.shift() ?? healthyFast,
        targetMs: 100,
      });
      expect(warmed.samples).toHaveLength(3);
    } finally {
      server.close();
    }
  });

  it("bounds trickled response bodies by the benchmark deadline", async () => {
    const sockets = new Set<Socket>();
    let bodyChunksSent = 0;
    let serverEndedResponse = false;
    const server = createRawServer((socket) => {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n ",
        );
        bodyChunksSent += 1;
        const interval = setInterval(() => {
          socket.write(" ");
          bodyChunksSent += 1;
        }, 10);
        const endTimer = setTimeout(() => {
          serverEndedResponse = true;
          socket.end();
        }, 500);
        socket.once("close", () => {
          clearInterval(interval);
          clearTimeout(endTimer);
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected raw HTTP test server address");
    }

    const startedAt = performance.now();
    try {
      await expect(
        testing.requestHttp({
          accept: "application/json",
          deadlineAt: startedAt + 150,
          path: "/readyz",
          port: address.port,
        }),
      ).rejects.toThrow("/readyz request timed out");
      expect(bodyChunksSent).toBeGreaterThan(1);
      expect(serverEndedResponse).toBe(false);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("reuses one connection for sequential successful HTTP samples", async () => {
    let connectionCount = 0;
    const server = createHttpServer((request, response) => {
      response.setHeader(
        "content-type",
        request.url === "/readyz" ? "application/json" : "text/html",
      );
      response.end(request.url === "/readyz" ? '{"status":"ok"}' : "<html></html>");
    });
    server.on("connection", () => {
      connectionCount += 1;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected HTTP test server address");
      }
      const deadlineAt = performance.now() + 5_000;

      await testing.requestHttp({
        accept: "application/json",
        deadlineAt,
        path: "/readyz",
        port: address.port,
      });
      await testing.requestHttp({
        accept: "text/html",
        deadlineAt,
        path: "/",
        port: address.port,
      });

      expect(connectionCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("loads through native Node TypeScript stripping", () => {
    const result = spawnSync(process.execPath, ["scripts/bench-gateway-concurrency.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw Gateway concurrency benchmark");
  });

  it("ends CLI failures with the required wrapper marker", () => {
    const result = spawnSync(process.execPath, ["scripts/bench-gateway-concurrency.ts", "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-gateway-concurrency] FAILED (exit 1)",
    );
  });
});
