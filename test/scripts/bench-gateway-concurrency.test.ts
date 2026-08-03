// Gateway concurrency benchmark tests cover CLI parsing and bounded percentile summaries.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
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

  it("preserves HTTP and RPC failures in baseline probe diagnostics", async () => {
    const probeOrder: string[] = [];
    const server = createServer((req, res) => {
      probeOrder.push(req.url ?? "missing-url");
      res.statusCode = req.url === "/readyz" ? 503 : 200;
      res.end(req.url === "/readyz" ? '{"status":"starting"}' : "not html");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
      expect(() => testing.assertBaselineProbes(sample)).toThrow(
        /readyz\(ok=false status=503 error=none .*sessionsList\(ok=false status=failed error="sessions\.list failed: unauthorized" .*controlUi\(ok=false status=200 error="response body did not contain <html"/u,
      );
    } finally {
      server.close();
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
