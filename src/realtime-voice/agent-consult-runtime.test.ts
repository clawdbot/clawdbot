import { describe, expect, it, vi } from "vitest";
import {
  consultRealtimeVoiceAgent,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "./agent-consult-tool.js";

function createAgentRuntime(payloads: unknown[] = [{ text: "Speak this." }]) {
  const sessionStore: Record<string, { sessionId?: string; updatedAt?: number }> = {};
  const runEmbeddedPiAgent = vi.fn(async () => ({
    payloads,
    meta: {},
  }));
  const updateSessionStore = vi.fn(
    async (
      _storePath: string,
      mutator: (store: Record<string, { sessionId?: string; updatedAt?: number }>) => unknown,
    ) => {
      return await mutator(sessionStore);
    },
  );
  return {
    runtime: {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      session: {
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        loadSessionStore: vi.fn(() => sessionStore),
        saveSessionStore: vi.fn(async () => {}),
        updateSessionStore,
        resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
      },
      runEmbeddedPiAgent,
    },
    runEmbeddedPiAgent,
    sessionStore,
  };
}

describe("realtime voice agent consult runtime", () => {
  it("exposes the shared consult tool based on policy", () => {
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

  it("runs an embedded agent using the shared session and prompt contract", async () => {
    const { runtime, runEmbeddedPiAgent, sessionStore } = createAgentRuntime();

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?", context: "Caller asked about PR #123." },
      transcript: [{ role: "user", text: "Can you check this?" }],
      surface: "a live phone call",
      userLabel: "Caller",
      questionSourceLabel: "caller",
      toolsAllow: ["read"],
      provider: "openai",
      model: "gpt-5.4",
      thinkLevel: "high",
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "Speak this." });
    expect(sessionStore["voice:15550001234"]?.sessionId).toBeTruthy();
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "voice:15550001234",
        sandboxSessionKey: "agent:main:voice:15550001234",
        agentId: "main",
        messageProvider: "voice",
        lane: "voice",
        toolsAllow: ["read"],
        provider: "openai",
        model: "gpt-5.4",
        thinkLevel: "high",
        timeoutMs: 10_000,
        prompt: expect.stringContaining("Caller: Can you check this?"),
      }),
    );
  });

  it("scopes sandbox resolution to the configured consult agent", async () => {
    const { runtime, runEmbeddedPiAgent } = createAgentRuntime();

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "voice",
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "voice:15550001234",
        sandboxSessionKey: "agent:voice:voice:15550001234",
        agentId: "voice",
      }),
    );
  });

  it("returns a speakable fallback when the embedded agent has no visible text", async () => {
    const warn = vi.fn();
    const { runtime } = createAgentRuntime([{ text: "hidden", isReasoning: true }]);

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn },
      sessionKey: "google-meet:meet-1",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What now?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
      fallbackText: "Let me verify that first.",
    });

    expect(result).toEqual({ text: "Let me verify that first." });
    expect(warn).toHaveBeenCalledWith(
      "[realtime-voice] agent consult produced no answer: agent returned no speakable text",
    );
  });
});
