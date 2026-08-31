import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  terminateVitestProcessGroupForTimeout,
  writeVitestProcessDiagnostics,
} from "../../scripts/vitest-process-group.mts";

const posixIt = process.platform === "win32" ? it.skip : it;

describe("vitest process diagnostics", () => {
  it("signals the process group before a stuck diagnostic and bounds the wait", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(() => true);
      const log = vi.fn();
      let diagnosticSignal: AbortSignal | undefined;
      const startDiagnostics = vi.fn((signal: AbortSignal) => {
        diagnosticSignal = signal;
        return new Promise<void>(() => {});
      });

      const result = terminateVitestProcessGroupForTimeout({
        child: { pid: 42 },
        diagnosticsDeadlineMs: 50,
        kill,
        log,
        platform: "darwin",
        startDiagnostics,
      });

      expect(kill).toHaveBeenCalledWith(-42, "SIGTERM");
      expect(startDiagnostics).not.toHaveBeenCalled();

      await Promise.resolve();
      expect(startDiagnostics).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      await expect(result.diagnostics).resolves.toBeUndefined();
      expect(diagnosticSignal?.aborted).toBe(true);
      expect(log).toHaveBeenCalledWith("[vitest] process diagnostics deadline reached after 50ms.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs only sanitized process fields and aggregate fd types", async () => {
    const log = vi.fn();
    const probe = vi.fn(async (command: string, args: string[]) => {
      if (command === "pgrep") {
        return "42\n43\n44\n";
      }
      if (command === "lsof") {
        return [
          "p42",
          "f0",
          "tCHR",
          "n/Users/alice/private-token",
          "f1",
          "tREG",
          "nhttps://internal.example/SECRET_TOKEN",
        ].join("\n");
      }
      if (command === "ps" && args.at(-1) === "42") {
        return "42 7 42 01:02 S 87.5 204800 wait /Users/alice/private/node --token SECRET_TOKEN";
      }
      return [
        "42 7 42 01:02 S 87.5 204800 wait /Users/alice/private/node --token SECRET_TOKEN",
        "43 42 42 01:01 D 12.5 102400 futex ci.internal.example:8443",
        "44 42 42 01:00 S 1.0 2048 wait SECRET_TOKEN",
      ].join("\n");
    });

    await writeVitestProcessDiagnostics({
      childPid: 42,
      log,
      platform: "darwin",
      probe,
      signal: new AbortController().signal,
    });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("comm=node");
    expect(output).toContain("comm=other");
    expect(output).toContain("fd summary: total=2 types=CHR:1,REG:1");
    expect(output).not.toMatch(
      /SECRET_TOKEN|internal\.example|\/Users\/alice|private-token|alice/u,
    );
  });

  it("degrades without probes on Windows", async () => {
    const log = vi.fn();
    const probe = vi.fn();

    await writeVitestProcessDiagnostics({
      childPid: 42,
      log,
      platform: "win32",
      probe,
      signal: new AbortController().signal,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[vitest] process diagnostics: pid=42 platform=win32 details=unavailable",
    );
  });

  posixIt("preserves SIGTERM exit 143 and the final failure trailer end to end", () => {
    const result = spawnSync(
      process.execPath,
      [
        nodePath.resolve("scripts/run-vitest.mjs"),
        "run",
        "--config",
        "test/vitest/vitest.tooling.config.ts",
        "test/scripts/run-vitest-profile.test.ts",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "0",
          OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "1",
        },
        timeout: 15_000,
      },
    );

    expect(result.signal).toBe("SIGTERM");
    expect(128 + osConstants.signals.SIGTERM).toBe(143);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[test] FAILED (exit 143)");
  });
});
