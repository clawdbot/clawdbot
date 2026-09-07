// Discord tests cover agent control plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeControlDiscordVoiceAgentRun } from "./agent-control.js";

const mocks = vi.hoisted(() => ({
  controlRealtimeVoiceAgentRun: vi.fn(),
  shouldAutoControlRealtimeVoiceAgentText: vi.fn(),
  resolveOwnedActiveRealtimeVoiceRunTargetForAgent: vi.fn(() => null),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/realtime-voice")>(
    "openclaw/plugin-sdk/realtime-voice",
  );
  return {
    ...actual,
    controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
    shouldAutoControlRealtimeVoiceAgentText: mocks.shouldAutoControlRealtimeVoiceAgentText,
    resolveOwnedActiveRealtimeVoiceRunTargetForAgent:
      mocks.resolveOwnedActiveRealtimeVoiceRunTargetForAgent,
  };
});

function createEntry() {
  return {
    route: { sessionKey: "discord:g1:c1", agentId: "agent-1" },
    generation: 1,
    sessionLifecycle: { status: "active" as const },
  } as Parameters<typeof maybeControlDiscordVoiceAgentRun>[0]["entry"];
}

describe("maybeControlDiscordVoiceAgentRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldAutoControlRealtimeVoiceAgentText.mockReturnValue(true);
    mocks.resolveOwnedActiveRealtimeVoiceRunTargetForAgent.mockReturnValue(null);
  });

  it("falls back for inactive cancel-like phrases", async () => {
    const result = {
      ok: true,
      active: false,
      mode: "cancel",
      sessionKey: "discord:g1:c1",
      message: "There is no active OpenClaw run to cancel.",
      speak: true,
      suppress: false,
    };
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue(result);

    await expect(
      maybeControlDiscordVoiceAgentRun({
        entry: createEntry(),
        text: "cancel my meeting tomorrow",
      }),
    ).resolves.toEqual({ handled: false, result });
    expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "discord:g1:c1",
      runTarget: null,
      text: "cancel my meeting tomorrow",
    });
  });

  it("handles active cancel requests with an explicit runTarget", async () => {
    const result = {
      ok: true,
      active: true,
      mode: "cancel",
      sessionKey: "discord:g1:c1",
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      suppress: false,
    };
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue(result);

    await expect(
      maybeControlDiscordVoiceAgentRun({
        entry: createEntry(),
        text: "cancel that",
      }),
    ).resolves.toEqual({
      handled: true,
      result,
      speakText: "Cancelled the active OpenClaw run.",
    });
    const args = mocks.controlRealtimeVoiceAgentRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).toEqual({
      sessionKey: "discord:g1:c1",
      runTarget: null,
      text: "cancel that",
    });
    expect(args).toHaveProperty("runTarget");
  });

  it("passes an owned runTarget when the Discord resolver admits one", async () => {
    const runTarget = {
      runId: "owned-run",
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
    mocks.resolveOwnedActiveRealtimeVoiceRunTargetForAgent.mockReturnValue(runTarget);
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue({
      ok: true,
      active: true,
      mode: "cancel",
      sessionKey: "discord:g1:c1",
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      suppress: false,
    });

    await maybeControlDiscordVoiceAgentRun({
      entry: createEntry(),
      text: "cancel that",
    });

    expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "discord:g1:c1",
      runTarget,
      text: "cancel that",
    });
  });

  it("ignores non-control phrases", async () => {
    mocks.shouldAutoControlRealtimeVoiceAgentText.mockReturnValue(false);

    await expect(
      maybeControlDiscordVoiceAgentRun({
        entry: createEntry(),
        text: "what is next",
      }),
    ).resolves.toEqual({ handled: false });
    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
  });
});
