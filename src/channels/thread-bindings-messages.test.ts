// Thread-binding message tests cover user-visible names and lifecycle text.
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings-messages.js";

describe("thread-binding names", () => {
  it("includes lifecycle details in intro text", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "main",
      label: "worker",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 48 * 60 * 60 * 1000,
    });

    expect(intro).toContain("idle auto-unfocus after 24h inactivity");
    expect(intro).toContain("max age 48h");
  });

  it("places the working directory before session details", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "codex",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      sessionCwd: "/home/bob/clawd",
      sessionDetails: ["session ids: pending (available after the first reply)"],
    });

    expect(intro).toContain("\ncwd: /home/bob/clawd\nsession ids: pending");
  });

  it("does not split surrogate pairs at native name limits", () => {
    const threadName = resolveThreadBindingThreadName({
      label: `${"x".repeat(96)}🚀tail`,
    });
    const intro = resolveThreadBindingIntroText({
      label: `${"x".repeat(99)}🚀tail`,
    });

    expect(threadName).toBe(`🤖 ${"x".repeat(96)}`);
    expect(intro).toContain(`${"x".repeat(99)} session active`);
  });
});
