import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
  buildRestartSuccessContinuation,
  consumeRestartSentinel,
  finalizeUpdateRestartSentinelRunningVersion,
  formatDoctorNonInteractiveHint,
  formatRestartSentinelMessage,
  markUpdateRestartSentinelFailure,
  readRestartSentinel,
  resolveRestartSentinelPath,
  summarizeRestartSentinel,
  trimLogTail,
  writeRestartSentinel,
} from "./restart-sentinel.js";

async function withRestartSentinelStateDir(run: () => Promise<void>): Promise<void> {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  try {
    await withTempDir({ prefix: "openclaw-sentinel-" }, async (tempDir) => {
      process.env.OPENCLAW_STATE_DIR = tempDir;
      await run();
    });
  } finally {
    envSnapshot.restore();
  }
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const statError = error as NodeJS.ErrnoException;
    expect({
      code: statError.code,
      path: statError.path,
      syscall: statError.syscall,
    }).toEqual({
      code: "ENOENT",
      path: targetPath,
      syscall: "stat",
    });
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

describe("restart sentinel", () => {
  it("writes and consumes a sentinel", async () => {
    await withRestartSentinelStateDir(async () => {
      const payload = {
        kind: "update" as const,
        status: "ok" as const,
        ts: Date.now(),
        sessionKey: "agent:main:mobilechat:dm:+15555550123",
        continuation: {
          kind: "agentTurn" as const,
          message: "Reply with exactly: Yay! I did it!",
        },
        stats: { mode: "git" },
      };
      const filePath = await writeRestartSentinel(payload);
      expect(filePath).toBe(resolveRestartSentinelPath());

      const read = await readRestartSentinel();
      expect(read?.payload.kind).toBe("update");
      expect(read?.payload.continuation).toEqual(payload.continuation);

      const consumed = await consumeRestartSentinel();
      expect(consumed?.payload.sessionKey).toBe(payload.sessionKey);
      expect(consumed?.payload.continuation).toEqual(payload.continuation);

      const empty = await readRestartSentinel();
      expect(empty).toBeNull();
    });
  });

  it("drops invalid sentinel payloads", async () => {
    await withRestartSentinelStateDir(async () => {
      const filePath = resolveRestartSentinelPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "not-json", "utf-8");

      const read = await readRestartSentinel();
      expect(read).toBeNull();

      await expectPathMissing(filePath);
    });
  });

  it("drops structurally invalid sentinel payloads", async () => {
    await withRestartSentinelStateDir(async () => {
      const filePath = resolveRestartSentinelPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ version: 2, payload: null }), "utf-8");

      await expect(readRestartSentinel()).resolves.toBeNull();
      await expectPathMissing(filePath);
    });
  });

  it("formatRestartSentinelMessage uses custom message when present", () => {
    const payload = {
      kind: "config-apply" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Config updated successfully",
    };
    expect(formatRestartSentinelMessage(payload)).toBe("Config updated successfully");
  });

  it("uses the exact auto-recovery message for config recovery notices", () => {
    const payload = {
      kind: "config-auto-recovery" as const,
      status: "ok" as const,
      ts: Date.now(),
      message:
        "Gateway recovered automatically after a failed config change and restored the last known good configuration.",
      stats: { mode: "config-auto-recovery", reason: "gateway-run-invalid-config" },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(payload.message);
    expect(summarizeRestartSentinel(payload)).toBe("Gateway auto-recovery");
  });

  it("formatRestartSentinelMessage falls back to summary when no message", () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
      stats: { mode: "git" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
    expect(result).toContain("update");
    expect(result).toContain("ok");
  });

  it("formatRestartSentinelMessage falls back to summary for blank message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "   ",
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
  });

  it("formats summary, distinct reason, and doctor hint together", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "error" as const,
      ts: Date.now(),
      message: "Patch failed",
      doctorHint: "Run openclaw doctor",
      stats: { mode: "patch", reason: "validation failed" },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(
      [
        "Gateway restart config-patch error (patch)",
        "Patch failed",
        "Reason: validation failed",
        "Run openclaw doctor",
      ].join("\n"),
    );
  });

  it("trims log tails", () => {
    const text = "a".repeat(9000);
    const trimmed = trimLogTail(text, 8000);
    expect(trimmed?.length).toBeLessThanOrEqual(8001);
    expect(trimmed?.startsWith("…")).toBe(true);
  });

  it("formats restart messages without volatile timestamps", () => {
    const payloadA = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: 100,
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const payloadB = { ...payloadA, ts: 200 };
    const textA = formatRestartSentinelMessage(payloadA);
    const textB = formatRestartSentinelMessage(payloadB);
    expect(textA).toBe(textB);
    expect(textA).toContain("Gateway restart restart ok");
    expect(textA).not.toContain('"ts"');
  });

  it("summarizes restart payloads and trims log tails without trailing whitespace", () => {
    expect(
      summarizeRestartSentinel({
        kind: "update",
        status: "skipped",
        ts: 1,
      }),
    ).toBe("Gateway restart update skipped");
    expect(trimLogTail("hello\n")).toBe("hello");
    expect(trimLogTail(undefined)).toBeNull();
  });

  it("writes the running version back to update sentinels on startup", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {
          after: { version: "expected-version" },
        },
      });

      await finalizeUpdateRestartSentinelRunningVersion("actual-version");

      await expect(readRestartSentinel()).resolves.toEqual({
        version: 1,
        payload: {
          kind: "update",
          status: "ok",
          ts,
          stats: {
            after: {
              version: "actual-version",
            },
          },
        },
      });
    });
  });

  it("marks update restart failures with a stable reason", async () => {
    await withRestartSentinelStateDir(async () => {
      const ts = Date.now();
      await writeRestartSentinel({
        kind: "update",
        status: "ok",
        ts,
        stats: {},
      });

      await markUpdateRestartSentinelFailure("restart-unhealthy");

      await expect(readRestartSentinel()).resolves.toEqual({
        version: 1,
        payload: {
          kind: "update",
          status: "error",
          ts,
          stats: {
            reason: "restart-unhealthy",
          },
        },
      });
    });
  });
});

describe("restart success continuation", () => {
  it("builds the default agent turn for session-scoped restarts", () => {
    expect(buildRestartSuccessContinuation({ sessionKey: "agent:main:main" })).toEqual({
      kind: "agentTurn",
      message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
    });
  });

  it("keeps explicit continuation messages", () => {
    expect(
      buildRestartSuccessContinuation({
        sessionKey: "agent:main:main",
        continuationMessage: "wake after restart",
      }),
    ).toEqual({
      kind: "agentTurn",
      message: "wake after restart",
    });
  });

  it("stays silent without session context", () => {
    expect(buildRestartSuccessContinuation({})).toBeNull();
  });
});

describe("restart sentinel message dedup", () => {
  it("omits duplicate Reason: line when stats.reason matches message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Applying config changes",
      stats: { mode: "gateway.restart", reason: "Applying config changes" },
    };
    const result = formatRestartSentinelMessage(payload);
    // The message text should appear exactly once, not duplicated as "Reason: ..."
    const occurrences = result.split("Applying config changes").length - 1;
    expect(occurrences).toBe(1);
    expect(result).not.toContain("Reason:");
  });

  it("keeps Reason: line when stats.reason differs from message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Restart requested by /restart");
    expect(result).toContain("Reason: /restart");
  });

  it("formats the non-interactive doctor command", () => {
    expect(formatDoctorNonInteractiveHint({ PATH: "/usr/bin:/bin" })).toContain(
      "openclaw doctor --non-interactive",
    );
  });
});
