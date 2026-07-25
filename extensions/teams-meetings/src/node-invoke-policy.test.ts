import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { resolveTeamsMeetingsConfig } from "./config.js";
import { createTeamsMeetingsNodeInvokePolicy } from "./node-invoke-policy.js";

describe("Microsoft Teams meetings node invoke policy", () => {
  it("replaces setup probe commands with trusted configured commands", async () => {
    const config = resolveTeamsMeetingsConfig({
      chrome: {
        audioInputCommand: ["trusted-input", "--read"],
        audioOutputCommand: ["trusted-output", "--write"],
        bargeInInputCommand: ["trusted-barge-in"],
      },
    });
    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    const policy = createTeamsMeetingsNodeInvokePolicy(config);

    await policy.handle({
      command: "teamsmeetings.chrome",
      config: {},
      invokeNode,
      nodeId: "node-1",
      params: {
        action: "setup",
        audioInputCommand: ["untrusted-input"],
        audioOutputCommand: ["untrusted-output"],
      },
    } as OpenClawPluginNodeInvokePolicyContext);

    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "setup",
        audioInputCommand: ["trusted-input", "--read"],
        audioOutputCommand: ["trusted-output", "--write"],
        bargeInInputCommand: ["trusted-barge-in"],
      },
    });
  });
});
