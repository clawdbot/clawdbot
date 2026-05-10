import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  providerOverride?: string;
  modelOverride?: string;
  modelOverrideSource?: string;
};

type EmbeddedAgentArgs = {
  extraSystemPrompt: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sandboxSessionKey?: string;
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
  sessionFile?: string;
  toolsAllow?: string[];
};

function createAgentRuntime(payloads: Array<Record<string, unknown>>) {
  const sessionStore: Record<string, TestSessionEntry> = {};
  const saveSessionStore = vi.fn(async () => {});
  const updateSessionStore = vi.fn(
    async (_storePath: string, mutator: (store: Record<string, TestSessionEntry>) => unknown) => {
      return await mutator(sessionStore);
    },
  );
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
      updateSessionStore,
      resolveSessionFilePath,
    },
  } as unknown as CoreAgentDeps;

  return {
    runtime,
    runEmbeddedPiAgent,
    saveSessionStore,
    updateSessionStore,
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
  const args = firstCall[0] as Partial<EmbeddedAgentArgs> | undefined;
  if (!args?.extraSystemPrompt) {
    throw new Error("voice response generator did not pass the spoken-output contract prompt");
  }
  return args as EmbeddedAgentArgs;
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
    const { runtime, runEmbeddedPiAgent, updateSessionStore, sessionStore } = createAgentRuntime([
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
    const pinnedSessionEntry = sessionStore["voice:15550001111"];
    expect(pinnedSessionEntry?.providerOverride).toBe("openai");
    expect(pinnedSessionEntry?.modelOverride).toBe("gpt-4.1-nano");
    expect(pinnedSessionEntry?.modelOverrideSource).toBe("auto");
    const updateSessionStoreCall = updateSessionStore.mock.calls[0];
    expect(updateSessionStoreCall?.[0]).toBe("/tmp/openclaw/main/sessions.json");
    expect(updateSessionStoreCall?.[1]).toBeTypeOf("function");
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.provider).toBe("openai");
    expect(args.model).toBe("gpt-4.1-nano");
    expect(args.sessionKey).toBe("voice:15550001111");
  });

  it("uses the persisted per-call session key for classic responses", async () => {
    const { runtime, runEmbeddedPiAgent, sessionStore } = createAgentRuntime([
      { text: '{"spoken":"Fresh call context."}' },
    ]);
    const voiceConfig = VoiceCallConfigSchema.parse({
      sessionScope: "per-call",
      responseTimeoutMs: 5000,
    });

    const result = await generateVoiceResponse({
      voiceConfig,
      coreConfig: {} as CoreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      sessionKey: "voice:call:call-123",
      from: "+15550001111",
      transcript: [{ speaker: "user", text: "hello there" }],
      userMessage: "hello there",
    });

    expect(result.text).toBe("Fresh call context.");
    const perCallSessionEntry = sessionStore["voice:call:call-123"];
    expect(perCallSessionEntry?.sessionId).toBeTypeOf("string");
    expect(perCallSessionEntry?.sessionId).not.toBe("");
    expect(sessionStore["voice:15550001111"]).toBeUndefined();
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.sessionKey).toBe("voice:call:call-123");
    expect(args.sandboxSessionKey).toBe("agent:main:voice:call:call-123");
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
      sessionStore,
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
    const defaultSessionEntry = sessionStore["voice:15550001111"];
    expect(defaultSessionEntry).toBeDefined();
    expect(resolveSessionFilePath).toHaveBeenCalledWith(
      defaultSessionEntry?.sessionId,
      defaultSessionEntry,
      {
        agentId: "main",
      },
    );
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.agentDir).toBe("/tmp/openclaw/agents/main");
    expect(args.agentId).toBe("main");
    expect(args.sandboxSessionKey).toBe("agent:main:voice:15550001111");
    expect(args.workspaceDir).toBe("/tmp/openclaw/workspace/main");
    expect(args.sessionFile).toBe("/tmp/openclaw/main/sessions/session.jsonl");
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
      sessionStore,
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
    const voiceSessionEntry = sessionStore["voice:15550001111"];
    expect(voiceSessionEntry).toBeDefined();
    expect(resolveSessionFilePath).toHaveBeenCalledWith(
      voiceSessionEntry?.sessionId,
      voiceSessionEntry,
      {
        agentId: "voice",
      },
    );
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.agentDir).toBe("/tmp/openclaw/agents/voice");
    expect(args.agentId).toBe("voice");
    expect(args.sandboxSessionKey).toBe("agent:voice:voice:15550001111");
    expect(args.workspaceDir).toBe("/tmp/openclaw/workspace/voice");
    expect(args.sessionFile).toBe("/tmp/openclaw/voice/sessions/session.jsonl");
  });

  it("passes the routed voice agent explicit tool allowlist to the embedded run", async () => {
    const { runtime, runEmbeddedPiAgent } = createAgentRuntime([
      { text: '{"spoken":"No tools needed."}' },
    ]);
    const coreConfig = {
      agents: {
        list: [
          {
            id: "voice",
            tools: { allow: [] },
          },
        ],
      },
    } as CoreConfig;

    const result = await generateVoiceResponse({
      voiceConfig: VoiceCallConfigSchema.parse({
        agentId: "voice",
        responseModel: "ollama/qwen2.5:1.5b",
        responseTimeoutMs: 5000,
      }),
      coreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      from: "+15550001111",
      transcript: [],
      userMessage: "hello there",
    });

    expect(result.text).toBe("No tools needed.");
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.agentId).toBe("voice");
    expect(args.toolsAllow).toStrictEqual([]);
  });
});
