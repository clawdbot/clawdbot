import { beforeEach, describe, expect, it, vi } from "vitest";

const consultRealtimeVoiceAgent = vi.hoisted(() => vi.fn(async () => ({ text: "done" })));

vi.mock("../talk/agent-consult-runtime.js", () => ({ consultRealtimeVoiceAgent }));

import { consultMeetingAgent, type MeetingAgentConsultSurface } from "./agent-consult.js";

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

describe("consultMeetingAgent", () => {
  beforeEach(() => {
    consultRealtimeVoiceAgent.mockClear();
  });

  it("targets the configured default agent when agentId is omitted", async () => {
    await consultMeetingAgent({
      surface,
      config: { agents: { list: [{ id: "operator", default: true }] } },
      runtime: { agent: {} } as never,
      logger: {} as never,
      toolPolicy: "safe-read-only",
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
    await consultMeetingAgent({
      surface,
      config: { agents: { list: [{ id: "operator", default: true }] } },
      runtime: { agent: {} } as never,
      logger: {} as never,
      agentId: "Support",
      toolPolicy: "safe-read-only",
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
});
