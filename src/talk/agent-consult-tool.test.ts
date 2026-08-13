// Agent consult tool tests cover tool payload validation for consult requests.
import { describe, expect, it } from "vitest";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPrompt,
  buildRealtimeVoiceSessionInstructions,
  collectRealtimeVoiceAgentConsultVisibleText,
  parseRealtimeVoiceAgentConsultArgs,
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-tool.js";
import type { RealtimeVoiceTool } from "./provider-types.js";

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

  it("normalizes a server-issued spoken confirmation id", () => {
    expect(
      parseRealtimeVoiceAgentConsultArgs({
        question: "Send it now",
        confirmationId: " confirm-123 ",
      }),
    ).toStrictEqual({
      question: "Send it now",
      context: undefined,
      responseStyle: undefined,
      confirmationId: "confirm-123",
    });
  });

  it("accepts provider question aliases from realtime tool calls", () => {
    expect(parseRealtimeVoiceAgentConsultArgs({ prompt: "  Check the repo. " })).toStrictEqual({
      context: undefined,
      question: "Check the repo.",
      responseStyle: undefined,
    });
    expect(
      parseRealtimeVoiceAgentConsultArgs({ query: "  Send a Discord message. " }),
    ).toStrictEqual({
      context: undefined,
      question: "Send a Discord message.",
      responseStyle: undefined,
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

    expect(prompt).toBe(
      [
        "Live voice request from the participant during a private Google Meet.",
        "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
        "When finished, return only the concise result the realtime voice agent should speak back.",
        "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
        "Recent voice transcript for context:\nParticipant: Can you check the repo?\nAgent: I'll verify.",
        "User request:\nDo we support realtime tools?",
      ].join("\n\n"),
    );
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

  it("builds byte-stable agent-proxy session instructions", () => {
    expect(
      buildRealtimeVoiceSessionInstructions({
        base: [
          "You are OpenClaw's Discord voice interface.",
          "Keep spoken replies concise, natural, and suitable for a live Discord voice channel.",
        ].join("\n"),
        isAgentProxy: true,
        bootstrapContextInstructions: "  Profile context.  ",
        toolPolicy: "owner",
        consultPolicy: "always",
      }),
    ).toBe(
      [
        "You are OpenClaw's Discord voice interface.\nKeep spoken replies concise, natural, and suitable for a live Discord voice channel.",
        "Profile context.",
        "Mode: OpenClaw agent proxy.",
        "You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
        "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
        "Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
        "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
        "Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
        'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
        "When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
        [
          "Consult behavior:",
          "- Call openclaw_agent_consult before every substantive answer.",
          "- You may answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting for the consult result.",
          "- After the consult result arrives, speak that result concisely.",
        ].join("\n"),
      ].join("\n\n"),
    );
    expect(
      buildRealtimeVoiceSessionInstructions({
        base: "Voice base.",
        isAgentProxy: true,
        toolPolicy: "none",
        consultPolicy: "auto",
      }),
    ).toContain("Voice base.\n\n\n\nMode: OpenClaw agent proxy.");
  });

  it("filters empty optional blocks from non-proxy session instructions", () => {
    expect(
      buildRealtimeVoiceSessionInstructions({
        base: "Voice base.",
        isAgentProxy: false,
        bootstrapContextInstructions: "   ",
        toolPolicy: "safe-read-only",
        consultPolicy: "auto",
      }),
    ).toBe(
      [
        "Voice base.",
        'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
      ].join("\n\n"),
    );
  });

  it("normalizes policy values and resolves shared tool exposure", () => {
    expect(resolveRealtimeVoiceAgentConsultToolPolicy(" OWNER ", "safe-read-only")).toBe("owner");
    expect(resolveRealtimeVoiceAgentConsultToolPolicy("bad", "safe-read-only")).toBe(
      "safe-read-only",
    );
    expect(resolveRealtimeVoiceAgentConsultTools("safe-read-only")).toStrictEqual([
      REALTIME_VOICE_AGENT_CONSULT_TOOL,
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none")).toStrictEqual([]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only")).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("owner")).toBeUndefined();
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("none")).toStrictEqual([]);
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
    ).toStrictEqual([REALTIME_VOICE_AGENT_CONSULT_TOOL, customTool]);
    expect(resolveRealtimeVoiceAgentConsultTools("none", [customTool])).toEqual([customTool]);
  });

  it("quarantines custom realtime tools with unreadable names before dedupe", () => {
    const unreadableNameTool: RealtimeVoiceTool = {
      type: "function" as const,
      get name(): string {
        throw new Error("unreadable tool name");
      },
      description: "Unreadable custom tool",
      parameters: { type: "object" as const, properties: {} },
    };
    const nonStringNameTool = {
      type: "function" as const,
      name: undefined,
      description: "Malformed custom tool",
      parameters: { type: "object" as const, properties: {} },
    } as unknown as RealtimeVoiceTool;
    const customTool: RealtimeVoiceTool = {
      type: "function" as const,
      name: "custom_lookup",
      description: "Custom lookup",
      parameters: { type: "object" as const, properties: {} },
    };

    expect(
      resolveRealtimeVoiceAgentConsultTools("safe-read-only", [
        unreadableNameTool,
        nonStringNameTool,
        customTool,
      ]),
    ).toStrictEqual([REALTIME_VOICE_AGENT_CONSULT_TOOL, customTool]);
    expect(resolveRealtimeVoiceAgentConsultTools("none", [unreadableNameTool, customTool])).toEqual(
      [customTool],
    );
  });
});
