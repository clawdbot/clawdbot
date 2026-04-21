import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  consumeRestartSentinel,
  formatDoctorNonInteractiveHint,
  formatRestartSentinelMessage,
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

describe("restart sentinel", () => {
  it("writes and consumes a sentinel", async () => {
    await withRestartSentinelStateDir(async () => {
      const payload = {
        kind: "update" as const,
        status: "ok" as const,
        ts: Date.now(),
        sessionKey: "agent:main:mobilechat:dm:+15555550123",
        stats: { mode: "git" },
      };
      const filePath = await writeRestartSentinel(payload);
      expect(filePath).toBe(resolveRestartSentinelPath());

      const read = await readRestartSentinel();
      expect(read?.payload.kind).toBe("update");

      const consumed = await consumeRestartSentinel();
      expect(consumed?.payload.sessionKey).toBe(payload.sessionKey);

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

      await expect(fs.stat(filePath)).rejects.toThrow();
    });
  });

  it("drops structurally invalid sentinel payloads", async () => {
    await withRestartSentinelStateDir(async () => {
      const filePath = resolveRestartSentinelPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ version: 2, payload: null }), "utf-8");

      await expect(readRestartSentinel()).resolves.toBeNull();
      await expect(fs.stat(filePath)).rejects.toThrow();
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
