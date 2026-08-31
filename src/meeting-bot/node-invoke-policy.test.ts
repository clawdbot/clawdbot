import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/plugin-registration.types.js";
import { createMeetingBrowserNodeInvokePolicy } from "./node-invoke-policy.js";

function createPolicy(
  audio: {
    audioInputCommandOverride?: string[];
    audioOutputCommandOverride?: string[];
  } = {},
) {
  return createMeetingBrowserNodeInvokePolicy({
    commandName: "testmeeting.chrome",
    deniedCode: "TEST_MEETING_DENIED",
    displayName: "Test meeting",
    normalizeUrl: (value) => String(value),
    start: {
      launch: true,
      joinTimeoutMs: 30_000,
      audioBackend: "auto",
      audioBufferBytes: 4_096,
      audioFormat: "pcm16-24khz",
      // Resolved local commands remain available to local Chrome but are not node overrides.
      audioInputCommand: ["gateway-generated-capture"],
      audioInputCommandOverride: audio.audioInputCommandOverride,
      audioOutputCommand: ["gateway-generated-playback"],
      audioOutputCommandOverride: audio.audioOutputCommandOverride,
      bargeInInputCommand: ["trusted-barge-in"],
    },
    supportedModes: new Set(["agent", "bidi", "transcribe"]),
    useConfiguredSetupCommands: true,
  });
}

function createContext(params: Record<string, unknown>) {
  const invokeNode = vi.fn(async () => ({ ok: true as const }));
  return {
    invokeNode,
    context: {
      command: "testmeeting.chrome",
      config: {},
      invokeNode,
      nodeId: "node-1",
      params,
    } as OpenClawPluginNodeInvokePolicyContext,
  };
}

describe("meeting browser node invoke policy audio", () => {
  it("forwards trusted declarations without gateway-generated command defaults", async () => {
    const policy = createPolicy();
    const { context, invokeNode } = createContext({
      action: "start",
      url: "https://meeting.test/call",
      mode: "bidi",
      audioBackend: "blackhole-2ch",
      audioBufferBytes: 1,
      audioFormat: "g711-ulaw-8khz",
      audioInputCommand: ["caller-capture"],
      audioOutputCommand: ["caller-playback"],
    });

    await policy.handle(context);

    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "start",
        url: "https://meeting.test/call",
        mode: "bidi",
        launch: true,
        browserProfile: undefined,
        joinTimeoutMs: 30_000,
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
        bargeInInputCommand: ["trusted-barge-in"],
      },
    });
  });

  it("forwards only trusted explicit command overrides for setup", async () => {
    const policy = createPolicy({
      audioInputCommandOverride: ["trusted-capture", "--raw"],
      audioOutputCommandOverride: ["trusted-playback", "--raw"],
    });
    const { context, invokeNode } = createContext({
      action: "setup",
      audioInputCommand: ["caller-capture"],
      audioOutputCommand: ["caller-playback"],
    });

    await policy.handle(context);

    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "setup",
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
        audioInputCommand: ["trusted-capture", "--raw"],
        audioOutputCommand: ["trusted-playback", "--raw"],
        bargeInInputCommand: ["trusted-barge-in"],
      },
    });
  });
});
