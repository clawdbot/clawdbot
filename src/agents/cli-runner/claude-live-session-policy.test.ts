import { describe, expect, it } from "vitest";
import { resolveClaudeLiveMode } from "./claude-live-session-policy.js";
import { readConfiguredExecPolicy } from "./claude-live-session.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

describe("resolveClaudeLiveMode", () => {
  it("keeps root on Claude default permissions while preserving YOLO elsewhere", () => {
    expect(resolveClaudeLiveMode("full", "off", 0)).toBe("default");
    expect(resolveClaudeLiveMode("full", "off", 1000)).toBe("bypassPermissions");
  });

  it("keeps restrictive OpenClaw policies on Claude default permissions", () => {
    expect(resolveClaudeLiveMode("allowlist", "on-miss", 1000)).toBe("default");
  });
});

describe("Claude live configured exec policy", () => {
  it("uses the configured default agent for an unscoped legacy session key", () => {
    const context = {
      params: {
        sessionKey: "main",
        config: {
          tools: { exec: { security: "full", ask: "off" } },
          agents: {
            entries: {
              main: {},
              ops: { default: true, tools: { exec: { security: "deny", ask: "always" } } },
            },
          },
        },
      },
    } as unknown as PreparedCliRunContext;

    expect(readConfiguredExecPolicy(context)).toEqual({
      agentId: "ops",
      security: "deny",
      ask: "always",
    });
  });
});
