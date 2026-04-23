import { describe, expect, it, vi } from "vitest";
import { createCliDebugTiming, formatCliDebugTimingCommand } from "./debug-timing.js";

function parseJsonTimingLine(line: string) {
  return JSON.parse(line) as {
    command: string;
    phase: string;
    elapsedMs: number;
    deltaMs: number;
    durationMs?: number;
    detail?: string;
    error?: boolean;
  };
}

describe("cli debug timing", () => {
  it("does not emit timing lines unless OPENCLAW_DEBUG_TIMING enables a mode", () => {
    const writer = vi.fn();
    const timing = createCliDebugTiming({
      command: "models list",
      env: {},
      writer,
    });

    timing.mark("start");
    timing.time("sync", () => 1);

    expect(timing.enabled).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it("emits readable timing lines with OPENCLAW_DEBUG_TIMING=1", () => {
    const writer = vi.fn();
    const timing = createCliDebugTiming({
      command: "models list",
      env: { OPENCLAW_DEBUG_TIMING: "1" },
      writer,
    });

    timing.mark("start", { detail: "ready" });
    expect(timing.time("sync", () => 1)).toBe(1);

    expect(writer.mock.calls.map(([line]) => String(line))).toEqual([
      'OpenClaw CLI debug timing: "models list"',
      expect.stringMatching(/\s+\d+ms\s+\+\d+ms "start" detail="ready"/),
      expect.stringMatching(/\s+\d+ms\s+\+\d+ms "sync" duration=\d+ms/),
    ]);
  });

  it("emits parseable timing JSON lines with OPENCLAW_DEBUG_TIMING=json", async () => {
    const writer = vi.fn();
    const timing = createCliDebugTiming({
      command: "models list",
      env: { OPENCLAW_DEBUG_TIMING: "json" },
      writer,
    });

    timing.mark("start", { detail: "ready" });
    expect(timing.time("sync", () => 1)).toBe(1);
    await expect(timing.timeAsync("async", async () => "ok")).resolves.toBe("ok");
    await expect(
      timing.timeAsync("reject", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    const payloads = writer.mock.calls.map(([line]) => parseJsonTimingLine(String(line)));
    expect(payloads).toEqual([
      expect.objectContaining({
        command: "models list",
        phase: "start",
        detail: "ready",
        elapsedMs: expect.any(Number),
        deltaMs: expect.any(Number),
      }),
      expect.objectContaining({
        command: "models list",
        phase: "sync",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        command: "models list",
        phase: "async",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        command: "models list",
        phase: "reject",
        durationMs: expect.any(Number),
        error: true,
      }),
    ]);
  });

  it("formats empty command paths as root", () => {
    expect(formatCliDebugTimingCommand([])).toBe("root");
    expect(formatCliDebugTimingCommand(["models", "list"])).toBe("models list");
  });
});
