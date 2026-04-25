import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";

function createAgentRuntime(payloads: Array<Record<string, unknown>>) {
  const sessionStore: Record<string, { sessionId: string; updatedAt: number }> = {};
  const saveSessionStore = vi.fn(async () => {});
  const runEmbeddedPiAgent = vi.fn(async () => ({
    payloads,
    meta: { durationMs: 12, aborted: false },
  }));
  const resolveAgentDir = vi.fn((_cfg: CoreConfig, agentId: string) => {
    return `/tmp/openclaw/agents/${agentId}`;
  });
  const resolveAgentWorkspaceDir = vi.fn((_cfg: CoreConfig, agentId: string) => {
    return `/tmp/openclaw/workspace/${agentId}`;
  });
  const resolveAgentIdentity = vi.fn((_cfg: CoreConfig, agentId: string) => ({
    name: `${agentId} tester`,
  }));
  const resolveStorePath = vi.fn((_store: string | undefined, params: { agentId?: string }) => {
    return `/tmp/openclaw/${params.agentId ?? "main"}/sessions.json`;
  });
  const resolveSessionFilePath = vi.fn(
    (_sessionId: string, _entry: unknown, params: { agentId?: string }) => {
      return `/tmp/openclaw/${params.agentId ?? "main"}/sessions/session.jsonl`;
    },
  );

  const runtime = {
    defaults: {
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
    },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveThinkingDefault: () => "off",
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => {},
    runEmbeddedPiAgent,
    session: {
      resolveStorePath,
      loadSessionStore: () => sessionStore,
      saveSessionStore,
      resolveSessionFilePath,
    },
  } as unknown as CoreAgentDeps;

  return {
    runtime,
    runEmbeddedPiAgent,
    saveSessionStore,
    sessionStore,
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveStorePath,
    resolveSessionFilePath,
  };
}

function requireEmbeddedAgentArgs(runEmbeddedPiAgent: ReturnType<typeof vi.fn>) {
  const calls = runEmbeddedPiAgent.mock.calls as unknown[][];
  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error("voice response generator did not invoke the embedded agent");
  }
  const args = firstCall[0] as
    | {
        extraSystemPrompt?: string;
        provider?: string;
        model?: string;
      }
    | undefined;
  if (!args?.extraSystemPrompt) {
    throw new Error("voice response generator did not pass the spoken-output contract prompt");
  }
  return args;
}

async function runGenerateVoiceResponse(
  payloads: Array<Record<string, unknown>>,
  overrides?: {
    runtime?: CoreAgentDeps;
    transcript?: Array<{ speaker: "user" | "bot"; text: string }>;
  },
) {
  const voiceConfig = VoiceCallConfigSchema.parse({
    responseTimeoutMs: 5000,
  });
  const coreConfig = {} as CoreConfig;
  const runtime = overrides?.runtime ?? createAgentRuntime(payloads).runtime;

  const result = await generateVoiceResponse({
    voiceConfig,
    coreConfig,
    agentRuntime: runtime,
    callId: "call-123",
    from: "+15550001111",
    transcript: overrides?.transcript ?? [{ speaker: "user", text: "hello there" }],
    userMessage: "hello there",
  });

  return { result };
}

describe("generateVoiceResponse", () => {
  it("suppresses reasoning payloads and reads structured spoken output", async () => {
    const { runtime, runEmbeddedPiAgent } = createAgentRuntime([
      { text: "Reasoning: hidden", isReasoning: true },
      { text: '{"spoken":"Hello from JSON."}' },
    ]);
    const { result } = await runGenerateVoiceResponse([], { runtime });

    expect(result.text).toBe("Hello from JSON.");
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.extraSystemPrompt).toContain('{"spoken":"..."}');
    expect(args.provider).toBe("together");
    expect(args.model).toBe("Qwen/Qwen2.5-7B-Instruct-Turbo");
  });

  it("extracts spoken text from fenced JSON", async () => {
    const { result } = await runGenerateVoiceResponse([
      { text: '```json\n{"spoken":"Fenced JSON works."}\n```' },
    ]);

    expect(result.text).toBe("Fenced JSON works.");
  });

  it("returns silence for an explicit empty spoken contract response", async () => {
    const { result } = await runGenerateVoiceResponse([{ text: '{"spoken":""}' }]);

    expect(result.text).toBeNull();
  });

  it("strips leading planning text when model returns plain text", async () => {
    const { result } = await runGenerateVoiceResponse([
      {
        text:
          "The user responded with short text. I should keep the response concise.\n\n" +
          "Sounds good. I can help with the next step whenever you are ready.",
      },
    ]);

    expect(result.text).toBe("Sounds good. I can help with the next step whenever you are ready.");
  });

  it("keeps plain conversational output when no JSON contract is followed", async () => {
    const { result } = await runGenerateVoiceResponse([
      { text: "Absolutely. Tell me what you want to do next." },
    ]);

    expect(result.text).toBe("Absolutely. Tell me what you want to do next.");
  });

  it("pins the voice session to responseModel before running the embedded agent", async () => {
    const { runtime, runEmbeddedPiAgent, saveSessionStore, sessionStore } = createAgentRuntime([
      { text: '{"spoken":"Pinned model works."}' },
    ]);
    const voiceConfig = VoiceCallConfigSchema.parse({
      responseModel: "openai/gpt-4.1-nano",
      responseTimeoutMs: 5000,
    });

    const result = await generateVoiceResponse({
      voiceConfig,
      coreConfig: {} as CoreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      from: "+15550001111",
      transcript: [{ speaker: "user", text: "hello there" }],
      userMessage: "hello there",
    });

    expect(result.text).toBe("Pinned model works.");
    expect(sessionStore["voice:15550001111"]).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4.1-nano",
      modelOverrideSource: "auto",
    });
    expect(saveSessionStore).toHaveBeenCalledWith("/tmp/openclaw/main/sessions.json", sessionStore);
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4.1-nano",
        sessionKey: "voice:15550001111",
      }),
    );
  });

  it("uses the main agent workspace when voice config omits agentId", async () => {
    const {
      runtime,
      runEmbeddedPiAgent,
      resolveAgentDir,
      resolveAgentWorkspaceDir,
      resolveAgentIdentity,
      resolveStorePath,
      resolveSessionFilePath,
    } = createAgentRuntime([{ text: '{"spoken":"Default agent."}' }]);
    const coreConfig = {} as CoreConfig;

    await generateVoiceResponse({
      voiceConfig: VoiceCallConfigSchema.parse({ responseTimeoutMs: 5000 }),
      coreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      from: "+15550001111",
      transcript: [],
      userMessage: "hello there",
    });

    expect(resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expect(resolveAgentDir).toHaveBeenCalledWith(coreConfig, "main");
    expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(coreConfig, "main");
    expect(resolveAgentIdentity).toHaveBeenCalledWith(coreConfig, "main");
    expect(resolveSessionFilePath).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      agentId: "main",
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/main",
        agentId: "main",
        sandboxSessionKey: "agent:main:voice:15550001111",
        workspaceDir: "/tmp/openclaw/workspace/main",
        sessionFile: "/tmp/openclaw/main/sessions/session.jsonl",
      }),
    );
  });

  it("uses the configured voice response agent workspace", async () => {
    const {
      runtime,
      runEmbeddedPiAgent,
      resolveAgentDir,
      resolveAgentWorkspaceDir,
      resolveAgentIdentity,
      resolveStorePath,
      resolveSessionFilePath,
    } = createAgentRuntime([{ text: '{"spoken":"Voice agent."}' }]);
    const coreConfig = {} as CoreConfig;

    const result = await generateVoiceResponse({
      voiceConfig: VoiceCallConfigSchema.parse({
        agentId: "voice",
        responseTimeoutMs: 5000,
      }),
      coreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      from: "+15550001111",
      transcript: [],
      userMessage: "hello there",
    });

    expect(result.text).toBe("Voice agent.");
    expect(resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "voice" });
    expect(resolveAgentDir).toHaveBeenCalledWith(coreConfig, "voice");
    expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(coreConfig, "voice");
    expect(resolveAgentIdentity).toHaveBeenCalledWith(coreConfig, "voice");
    expect(resolveSessionFilePath).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      agentId: "voice",
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/voice",
        agentId: "voice",
        sandboxSessionKey: "agent:voice:voice:15550001111",
        workspaceDir: "/tmp/openclaw/workspace/voice",
        sessionFile: "/tmp/openclaw/voice/sessions/session.jsonl",
      }),
    );
  });
});
