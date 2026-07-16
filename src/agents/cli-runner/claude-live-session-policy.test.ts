import { describe, expect, it } from "vitest";
import { resolveClaudeLiveMode } from "./claude-live-session-policy.js";

describe("resolveClaudeLiveMode", () => {
  it("keeps root on Claude default permissions while preserving YOLO elsewhere", () => {
    expect(resolveClaudeLiveMode("full", "off", 0)).toBe("default");
    expect(resolveClaudeLiveMode("full", "off", 1000)).toBe("bypassPermissions");
  });

  it("keeps restrictive OpenClaw policies on Claude default permissions", () => {
    expect(resolveClaudeLiveMode("allowlist", "on-miss", 1000)).toBe("default");
  });
});
