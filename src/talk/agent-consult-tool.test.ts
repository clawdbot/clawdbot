import { describe, expect, it } from "vitest";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  parseRealtimeVoiceAgentConsultArgs,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-tool.js";

describe("realtime voice agent consult tool", () => {
  it("normalizes shared tool arguments for browser chat forwarding", () => {
    expect(
      buildRealtimeVoiceAgentConsultChatMessage({
        question: "  What changed? ",
        context: "  PR #123 ",
        responseStyle: " concise ",
      }),
    ).toBe("What changed?\n\nContext:\nPR #123\n\nSpoken style:\nconcise");
  });

  it("requires a non-empty question", () => {
    expect(() => parseRealtimeVoiceAgentConsultArgs({ context: "missing" })).toThrow(
      "question required",
    );
  });

  it("accepts provider question aliases from realtime tool calls", () => {
    expect(parseRealtimeVoiceAgentConsultArgs({ prompt: "  Check the repo. " })).toMatchObject({
      question: "Check the repo.",
    });
    expect(
      parseRealtimeVoiceAgentConsultArgs({ query: "  Send a Discord message. " }),
    ).toMatchObject({
      question: "Send a Discord message.",
    });
  });

  it("builds a delegated voice request prompt with recent transcript", () => {
    const prompt = buildRealtimeVoiceAgentConsultPrompt({
      args: { question: "Do we support realtime tools?" },
      transcript: [
        { role: "user", text: "Can you check the repo?" },
        { role: "assistant", text: "I'll verify." },
      ],
      surface: "a private Google Meet",
      userLabel: "Participant",
      assistantLabel: "Agent",
      questionSourceLabel: "participant",
    });

    expect(prompt).toContain(
      "Live voice request from the participant during a private Google Meet",
    );
    expect(prompt).toContain("Act as the configured OpenClaw agent on behalf of this user");
    expect(prompt).toContain("Participant: Can you check the repo?");
    expect(prompt).toContain("Agent: I'll verify.");
    expect(prompt).toContain("User request:\nDo we support realtime tools?");
  });

  it("filters reasoning and error payloads from visible consult output", () => {
    expect(
      collectRealtimeVoiceAgentConsultVisibleText([
        { text: "thinking", isReasoning: true },
        { text: "first" },
        { text: "error", isError: true },
        { text: "second" },
      ]),
    ).toBe("first\n\nsecond");
  });

  it("normalizes policy values and resolves shared tool exposure", () => {
    expect(resolveRealtimeVoiceAgentConsultToolPolicy(" OWNER ", "safe-read-only")).toBe("owner");
    expect(resolveRealtimeVoiceAgentConsultToolPolicy("bad", "safe-read-only")).toBe(
      "safe-read-only",
    );
    expect(resolveRealtimeVoiceAgentConsultTools("safe-read-only")).toEqual([
      expect.objectContaining({ name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME }),
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none")).toEqual([]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only")).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("owner")).toBeUndefined();
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("none")).toEqual([]);
  });

  it("keeps the shared consult tool ahead of custom realtime tools and dedupes by name", () => {
    const customTool = {
      type: "function" as const,
      name: "custom_lookup",
      description: "Custom lookup",
      parameters: { type: "object" as const, properties: {} },
    };
    const duplicateConsultTool = { ...customTool, name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME };

    expect(
      resolveRealtimeVoiceAgentConsultTools("safe-read-only", [duplicateConsultTool, customTool]),
    ).toEqual([
      expect.objectContaining({ name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME }),
      customTool,
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none", [customTool])).toEqual([customTool]);
  });
});
