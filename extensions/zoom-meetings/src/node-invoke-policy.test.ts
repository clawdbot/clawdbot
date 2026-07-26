import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { resolveZoomMeetingsConfig } from "./config.js";
import { createZoomMeetingsNodeInvokePolicy } from "./node-invoke-policy.js";

describe("Zoom meetings node invoke policy", () => {
  it("replaces setup probe commands with trusted configured commands", async () => {
    const config = resolveZoomMeetingsConfig({
      chrome: {
        audioInputCommand: ["trusted-input", "--read"],
        audioOutputCommand: ["trusted-output", "--write"],
        bargeInInputCommand: ["trusted-barge-in"],
      },
    });
    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    const policy = createZoomMeetingsNodeInvokePolicy(config);

    await policy.handle({
      command: "zoommeetings.chrome",
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
