import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";

const consultRealtimeVoiceAgent = vi.hoisted(() => vi.fn(async () => ({ text: "done" })));

vi.mock("../talk/agent-consult-runtime.js", () => ({ consultRealtimeVoiceAgent }));

import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import type {
  MeetingAgentConsultSurface,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";

const surface: MeetingAgentConsultSurface = {
  id: "test-meeting",
  provider: "test-meeting",
  lane: "test-meeting",
  surface: "a test meeting",
  userLabel: "Participant",
  assistantLabel: "Agent",
  questionSourceLabel: "participant",
  workingResponseLabel: "participant",
  extraSystemPrompt: "Answer briefly.",
};

const platform: MeetingPlatformRuntimeMetadata = {
  id: "test-meeting",
  displayName: "Test Meeting",
  logScope: "[test-meeting]",
  agentConsult: {
    surface: surface.surface,
    userLabel: surface.userLabel,
    assistantLabel: surface.assistantLabel,
    questionSourceLabel: surface.questionSourceLabel,
    workingResponseLabel: surface.workingResponseLabel,
    extraSystemPrompt: surface.extraSystemPrompt,
  },
  session: {
    idPrefix: "test_meeting",
    participantIdentity: () => "Test participant",
  },
};

function createBindings(agentId: string | undefined) {
  return createMeetingRealtimeEngineBindings({
    platform,
    config: {
      realtime: { ...(agentId ? { agentId } : {}), toolPolicy: "safe-read-only" },
    },
    fullConfig: { agents: { list: [{ id: "operator", default: true }] } },
    runtime: { agent: {} } as never,
    logger: {} as never,
  });
}

function makeSession(
  submitToolResult: RealtimeVoiceBridgeSession["submitToolResult"],
  supportsToolResultContinuation = false,
): RealtimeVoiceBridgeSession {
  return {
    bridge: { supportsToolResultContinuation },
    submitToolResult,
  } as unknown as RealtimeVoiceBridgeSession;
}

describe("createMeetingRealtimeEngineBindings", () => {
  beforeEach(() => {
    consultRealtimeVoiceAgent.mockClear();
  });

  it("targets the configured default agent when agentId is omitted", async () => {
    await createBindings(undefined).consultAgent({
      meetingSessionId: "meeting-1",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "operator",
        sessionKey: "agent:operator:subagent:test-meeting:meeting-1",
        spawnedBy: "agent:operator:main",
      }),
    );
  });

  it("keeps an explicit agentId ahead of the configured default", async () => {
    await createBindings("Support").consultAgent({
      meetingSessionId: "meeting-2",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        sessionKey: "agent:support:subagent:test-meeting:meeting-2",
        spawnedBy: "agent:support:main",
      }),
    );
  });

  it("derives realtime engine bindings from platform metadata", async () => {
    const bindings = createBindings("Support");

    expect(bindings.platform).toEqual({
      displayName: "Test Meeting",
      logScope: "[test-meeting]",
      sessionIdPrefix: "test-meeting",
    });
    await bindings.consultAgent({
      meetingSessionId: "meeting-3",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        messageProvider: "test-meeting",
        lane: "test-meeting",
        surface: "a test meeting",
        sessionKey: "agent:support:subagent:test-meeting:meeting-3",
      }),
    );
  });

  it("emits a final tool event only after the bridge accepts the result", async () => {
    let acceptResult = () => {};
    const accepted = new Promise<void>((resolve) => {
      acceptResult = resolve;
    });
    const submitToolResult = vi.fn(() => accepted);
    const events: Array<{ type: string; final?: boolean }> = [];

    const handled = createBindings("Support").handleToolCall({
      strategy: "agent",
      session: makeSession(submitToolResult),
      event: {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "What should I say?" },
      },
      meetingSessionId: "meeting-4",
      transcript: [],
      onTalkEvent: (event) => events.push(event),
    });

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    acceptResult();
    await handled;
    expect(events).toEqual([expect.objectContaining({ type: "tool.error", final: true })]);
  });

  it("does not retry a rejected result submission as a second tool error", async () => {
    const submitToolResult = vi.fn(async () => {
      throw new Error("result delivery failed");
    });
    const events: Array<{ type: string }> = [];

    await expect(
      createBindings("Support").handleToolCall({
        strategy: "bidi",
        session: makeSession(submitToolResult),
        event: {
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "What should I say?" },
        },
        meetingSessionId: "meeting-5",
        transcript: [],
        onTalkEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("result delivery failed");

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledTimes(1);
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["tool.progress"]);
  });
});
