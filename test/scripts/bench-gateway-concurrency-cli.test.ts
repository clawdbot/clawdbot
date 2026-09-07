import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

type ChildReceipt = {
  exitCode: number | null;
  signal: string | null;
  exitedBeforeTeardown: boolean;
};
type ProcessSnapshot = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  exitEvent?: { exitCode: number | null; signal: string | null };
};
type RunReport = {
  cleanup: { rootRemoved: boolean };
  failures: Array<{ phase: "workload" | "diagnostics" | "cleanup"; error: string }>;
  freshConnection: { ok: boolean } | null;
  gatewayExit?: ChildReceipt;
  gatewayProcess?: ProcessSnapshot;
  history: Array<{ ok: boolean; error: string | null }>;
  memory: { before: unknown; after: unknown; peakRssMb: number | null };
  mockProviderExit?: ChildReceipt;
  mockProviderProcess?: ProcessSnapshot;
  pluginMetadataScans: unknown;
  readyz: Array<{ ok: boolean }>;
  sessionsList: Array<{ ok: boolean }>;
};
type Report = {
  mode: string;
  runs: RunReport[];
  warmupRuns: RunReport[];
  summary: { pluginMetadataScanCount: number | null };
};

async function withBenchmark(
  failure: "protocol" | "workload" | "teardown" | "history" | "none",
  check: (report: Report, receipt: { pid: number; root: string } | null) => void,
) {
  await withTempDir("openclaw-concurrency-cli-", async (root) => {
    const tempRoot = path.join(root, "tmp");
    const entry = path.join(root, `${failure}.mjs`);
    const output = path.join(root, "report.json");
    const receiptPath = path.join(root, "fixture-receipt.json");
    mkdirSync(tempRoot);
    if (failure !== "protocol") {
      const fixture = new URL("./fixtures/gateway-concurrency-entry.mjs", import.meta.url);
      writeFileSync(entry, `import ${JSON.stringify(fixture.href)};\n`);
      const protocolDirectory = path.join(root, "gateway", "protocol");
      mkdirSync(protocolDirectory, { recursive: true });
      writeFileSync(
        path.join(protocolDirectory, "index.js"),
        "export const PROTOCOL_VERSION = 1;\n",
      );
    }
    const result = spawnSync(
      process.execPath,
      [
        "scripts/bench-gateway-concurrency.ts",
        "--entry",
        entry,
        "--concurrency",
        "1",
        "--cadence-ms",
        "10",
        "--timeout-ms",
        "5000",
        "--output",
        output,
        "--json",
        ...(failure === "workload" ? ["--no-diagnostics-timeline"] : []),
        ...(failure === "history" ? ["--history-clients", "1", "--history-burst", "1"] : []),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    const receipt = existsSync(receiptPath)
      ? (JSON.parse(readFileSync(receiptPath, "utf8")) as { pid: number; root: string })
      : null;
    try {
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(failure === "none" ? 0 : 1);
      if (failure !== "none") {
        expect(result.stderr.trim().split("\n").at(-1)).toBe(
          "[bench-gateway-concurrency] FAILED (exit 1)",
        );
      }
      expect(existsSync(output), `failed benchmark did not write JSON:\n${result.stderr}`).toBe(
        true,
      );
      const report = JSON.parse(readFileSync(output, "utf8")) as Report;
      expect(JSON.parse(result.stdout)).toEqual(report);
      expect(report.mode).toBe("mock-streaming-agent");
      expect(report.runs).toHaveLength(1);
      expect(report.warmupRuns).toEqual([]);
      expect(report.runs[0]?.cleanup).toEqual({ rootRemoved: true });
      expect(readdirSync(tempRoot)).toEqual([]);
      if (receipt) {
        expect(existsSync(receipt.root)).toBe(false);
        expect(() => process.kill(receipt.pid, 0)).toThrow();
      }
      check(report, receipt);
    } finally {
      if (receipt) {
        try {
          process.kill(receipt.pid, "SIGKILL");
        } catch {
          // The benchmark normally owns teardown; reclaim only this fixture if it failed.
        }
      }
    }
  });
}

describe("gateway concurrency CLI failure evidence", () => {
  it("retains an unstarted attempt and removes its root when protocol loading fails", async () => {
    await withBenchmark("protocol", (report, receipt) => {
      const run = report.runs[0]!;
      expect(receipt).toBeNull();
      expect(run.failures).toEqual([
        { phase: "workload", error: expect.stringContaining("gateway/protocol/index.js") },
      ]);
      expect(run.freshConnection).toBeNull();
      expect(run.memory).toEqual({ before: null, after: null, peakRssMb: null });
      expect(run.pluginMetadataScans).toBeNull();
      expect(report.summary.pluginMetadataScanCount).toBeNull();
      expect(run.gatewayExit ?? null).toBeNull();
      expect(run.mockProviderExit ?? null).toBeNull();
      expect(run.gatewayProcess?.pid).toBeUndefined();
      expect(run.mockProviderProcess?.pid).toBeUndefined();
    });
  });

  it("retains completed probes and teardown observations when an accepted turn fails", async () => {
    await withBenchmark("workload", (report, receipt) => {
      const run = report.runs[0]!;
      expect(receipt).not.toBeNull();
      expect(run.failures).toEqual([
        { phase: "workload", error: expect.stringContaining("agent 1 did not complete") },
      ]);
      expect(run.readyz.some((sample) => sample.ok)).toBe(true);
      expect(run.sessionsList.some((sample) => sample.ok)).toBe(true);
      expect(run.memory.before).not.toBeNull();
      expect(run.pluginMetadataScans).toBeNull();
      expect(run.gatewayExit).toEqual({ exitCode: 0, signal: null, exitedBeforeTeardown: false });
      expect(run.gatewayProcess).toMatchObject({
        pid: receipt?.pid,
        exitEvent: { exitCode: 0, signal: null },
      });
      expect(run.mockProviderExit).toBeDefined();
      expect(run.mockProviderProcess?.exitEvent).toBeDefined();
    });
  });

  it.skipIf(process.platform === "win32")(
    "retains completed load when bounded teardown requires SIGKILL",
    async () => {
      await withBenchmark("teardown", (report, receipt) => {
        const run = report.runs[0]!;
        expect(run.failures).toContainEqual({
          phase: "diagnostics",
          error: expect.stringContaining("Gateway did not exit cleanly"),
        });
        expect(run.readyz.some((sample) => sample.ok)).toBe(true);
        expect(run.freshConnection).toMatchObject({ ok: true });
        expect(run.memory.after).not.toBeNull();
        expect(run.pluginMetadataScans).toBeNull();
        expect(report.summary.pluginMetadataScanCount).toBeNull();
        expect(run.gatewayExit).toEqual({
          exitCode: null,
          signal: "SIGKILL",
          exitedBeforeTeardown: false,
        });
        expect(run.gatewayProcess).toMatchObject({
          pid: receipt?.pid,
          signalCode: "SIGKILL",
          exitEvent: { exitCode: null, signal: "SIGKILL" },
        });
        expect(run.mockProviderExit).toBeDefined();
        expect(run.mockProviderProcess?.exitEvent).toBeDefined();
      });
    },
    20_000,
  );

  it("retains load timeline spans when completed history probes all fail", async () => {
    await withBenchmark("history", (report) => {
      const run = report.runs[0]!;
      expect(run.failures).toEqual([
        {
          phase: "workload",
          error: expect.stringContaining("all configured chat.history load probes failed"),
        },
      ]);
      expect(run.history.length).toBeGreaterThan(0);
      expect(
        run.history.every(
          (sample) => !sample.ok && sample.error?.includes("fixture history failure"),
        ),
      ).toBe(true);
      expect(run.readyz.some((sample) => sample.ok)).toBe(true);
      expect(run.gatewayExit).toEqual({ exitCode: 0, signal: null, exitedBeforeTeardown: false });
      expect(run.pluginMetadataScans).toMatchObject({ count: 1, totalDurationMs: 7 });
      expect(report.summary.pluginMetadataScanCount).toBe(1);
    });
  });

  it("preserves successful CLI output and validated zero-scan evidence", async () => {
    await withBenchmark("none", (report) => {
      const run = report.runs[0]!;
      expect(run.failures).toEqual([]);
      expect(run.freshConnection).toMatchObject({ ok: true });
      expect(run.memory).toMatchObject({
        before: { heapUsedMb: 4, rssMb: 16 },
        after: { heapUsedMb: 4, rssMb: 16 },
      });
      expect(run.pluginMetadataScans).toEqual({ count: 0, durationMs: null, totalDurationMs: 0 });
      expect(report.summary.pluginMetadataScanCount).toBe(0);
      expect(run.gatewayExit).toEqual({ exitCode: 0, signal: null, exitedBeforeTeardown: false });
    });
  });
});
