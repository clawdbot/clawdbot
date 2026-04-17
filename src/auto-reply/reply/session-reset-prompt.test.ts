import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildBareSessionResetPrompt } from "./session-reset-prompt.js";

describe("buildBareSessionResetPrompt", () => {
  it("includes the explicit Session Startup instruction for bare /new and /reset", () => {
    const prompt = buildBareSessionResetPrompt();
    expect(prompt).toContain("Execute your Session Startup sequence now");
    expect(prompt).toContain("read the required files before responding to the user");
    expect(prompt).toContain("If BOOTSTRAP.md exists in the provided Project Context");
    expect(prompt).toContain("read it and follow its instructions first");
    expect(prompt).not.toContain(
      "If runtime-provided startup context is included for this first turn",
    );
  });

  it("appends current time line so agents know the date", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;
    // 2026-03-03 14:00 UTC = 2026-03-03 09:00 EST
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(cfg, nowMs);
    expect(prompt).toContain(
      "Current time: Tuesday, March 3rd, 2026 - 9:00 AM (America/New_York) / 2026-03-03 14:00 UTC",
    );
  });

  it("does not append a duplicate current time line", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("falls back to UTC when no timezone configured", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect(prompt).toContain("Current time:");
  });
});
