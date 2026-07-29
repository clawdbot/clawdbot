// Voice Call tests cover response generator plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  agentHarnessId?: string;
  agentRuntimeOverride?: string;
  providerOverride?: string;
  modelOverride?: string;
  modelOverrideSource?: string;
  model?: string;
  modelProvider?: string;
  modelSelectionLocked?: boolean;
  pluginExtensions?: Record<string, unknown>;
  contextTokens?: number;
  authProfileOverride?: string;
};

type EmbeddedAgentArgs = {
  abortSignal?: AbortSignal;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  extraSystemPrompt: string;
  provider?: string;
  model?: string;
  modelSelectionLocked?: boolean;
  sessionKey?: string;
  sessionTarget?: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    storePath?: string;
  };
  sandboxSessionKey?: string;
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
  sessionFile?: string;
  toolsAllow?: string[];
  blockReplyBreak?: "text_end" | "message_end";
  onBlockReply?: (
    payload: Record<string, unknown>,
    context?: { assistantMessageIndex?: number },
  ) => void;
  onBlockReplyFlush?: (
    context:
      | { reason: "message_end" | "terminal" }
      | { reason: "tool_start"; assistantMessageIndex: number }
      | { reason: "pre_compaction"; attemptAccepted: boolean },
  ) => void | Promise<void>;
};

function createAgentRuntime(
  payloads: Array<Record<string, unknown>>,
  options?: { blockReplyPayloads?: Array<Record<string, unknown>> },
) {
  const sessionStore: Record<string, TestSessionEntry> = {};
  const saveSessionStore = vi.fn(async () => {});
  const updateSessionStore = vi.fn(
    async (_storePath: string, mutator: (store: Record<string, TestSessionEntry>) => unknown) => {
      return await mutator(sessionStore);
    },
  );
  const getSessionEntry = vi.fn(
    (params: { sessionKey: string }) => sessionStore[params.sessionKey],
  );
  const patchSessionEntry = vi.fn(
    async (params: {
      sessionKey: string;
      fallbackEntry?: TestSessionEntry;
      replaceEntry?: boolean;
      update: (entry: TestSessionEntry) => Partial<TestSessionEntry> | null;
    }) => {
      const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = params.update({ ...existing });
      if (!patch) {
        return existing;
      }
      const next = params.replaceEntry ? (patch as TestSessionEntry) : { ...existing, ...patch };
      sessionStore[params.sessionKey] = next;
      return next;
    },
  );
  const upsertSessionEntry = vi.fn(
    async (params: { sessionKey: string; entry: TestSessionEntry }) => {
      sessionStore[params.sessionKey] = { ...params.entry };
    },
  );
  const runEmbeddedAgent = vi.fn(async (args: EmbeddedAgentArgs) => {
    for (const payload of options?.blockReplyPayloads ?? []) {
      args.onBlockReply?.(payload, { assistantMessageIndex: 0 });
    }
    await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
    return {
      payloads,
      meta: { durationMs: 12, aborted: false },
    };
  });
  const runWithWorkAdmission = vi.fn(
    async (
      _params: { storePath: string; sessionKey: string },
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => await run(new AbortController().signal),
  );
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
    runEmbeddedAgent,
    session: {
      resolveStorePath,
      loadSessionStore: () => sessionStore,
      saveSessionStore,
      updateSessionStore,
      getSessionEntry,
      patchSessionEntry,
      upsertSessionEntry,
      runWithWorkAdmission,
      resolveSessionFilePath,
    },
  } as unknown as CoreAgentDeps;

  return {
    runtime,
    runEmbeddedAgent,
    runWithWorkAdmission,
    saveSessionStore,
    updateSessionStore,
    patchSessionEntry,
    sessionStore,
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveStorePath,
    resolveSessionFilePath,
  };
}

function requireEmbeddedAgentArgs(runEmbeddedAgent: ReturnType<typeof vi.fn>) {
  const calls = runEmbeddedAgent.mock.calls as unknown[][];
  const firstCall = requireFirstMockCall(
    calls,
    "voice response generator embedded agent invocation",
  );
  const args = firstCall[0] as Partial<EmbeddedAgentArgs> | undefined;
  if (!args?.extraSystemPrompt) {
    throw new Error("voice response generator did not pass the spoken-output contract prompt");
  }
  return args as EmbeddedAgentArgs;
}

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

async function runGenerateVoiceResponse(
  payloads: Array<Record<string, unknown>>,
  overrides?: {
    runtime?: CoreAgentDeps;
    transcript?: Array<{ speaker: "user" | "bot"; text: string }>;
    onEarlyText?: (text: string) => Promise<boolean>;
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
    onEarlyText: overrides?.onEarlyText,
  });

  return { result };
}

describe("generateVoiceResponse", () => {
  it("suppresses reasoning payloads and reads structured spoken output", async () => {
    const { runtime, runEmbeddedAgent, runWithWorkAdmission } = createAgentRuntime([
      { text: "Reasoning: hidden", isReasoning: true },
      { text: '{"spoken":"Hello from JSON."}' },
    ]);
    const { result } = await runGenerateVoiceResponse([], { runtime });

    expect(result.text).toBe("Hello from JSON.");
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const args = requireEmbeddedAgentArgs(runEmbeddedAgent);
    expect(args.extraSystemPrompt).toContain('{"spoken":"..."}');
    expect(args.provider).toBe("together");
    expect(args.model).toBe("Qwen/Qwen2.5-7B-Instruct-Turbo");
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(args.blockReplyBreak).toBe("text_end");
    expect(args.onBlockReply).toEqual(expect.any(Function));
    expect(args.onBlockReplyFlush).toEqual(expect.any(Function));
    expect(runWithWorkAdmission).toHaveBeenCalledWith(
      {
        storePath: "/tmp/openclaw/main/sessions.json",
        sessionKey: "agent:main:voice:15550001111",
      },
      expect.any(Function),
    );
  });

  it("returns the lifecycle rejection without starting the embedded agent", async () => {
    const { runtime, runEmbeddedAgent, runWithWorkAdmission } = createAgentRuntime([]);
    runWithWorkAdmission.mockRejectedValueOnce(
      new Error('Session "agent:main:voice:15550001111" is archived.'),
    );

    const { result } = await runGenerateVoiceResponse([], { runtime });

    expect(result).toEqual({
      text: null,
      deliveredEarly: false,
      error: 'Error: Session "agent:main:voice:15550001111" is archived.',
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("delivers a completed reply block before the embedded run settles", async () => {
    let finishRun: (value: {
      payloads: Array<Record<string, unknown>>;
      meta: { durationMs: number; aborted: boolean };
    }) => void = () => {};
    const runFinished = new Promise<{
      payloads: Array<Record<string, unknown>>;
      meta: { durationMs: number; aborted: boolean };
    }>((resolve) => {
      finishRun = resolve;
    });
    const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
    runEmbeddedAgent.mockImplementationOnce(async (args: EmbeddedAgentArgs) => {
      args.onBlockReply?.({ text: '{"spoken":"Already ready."}' });
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      return await runFinished;
    });
    let reportEarlyDelivery: () => void = () => {};
    const earlyDeliveryStarted = new Promise<void>((resolve) => {
      reportEarlyDelivery = resolve;
    });
    const onEarlyText = vi.fn(async () => {
      reportEarlyDelivery();
      return true;
    });

    const response = runGenerateVoiceResponse([], { runtime, onEarlyText });
    await earlyDeliveryStarted;

    expect(onEarlyText).toHaveBeenCalledWith("Already ready.");
    finishRun({ payloads: [], meta: { durationMs: 20_000, aborted: false } });
    await expect(response).resolves.toEqual({
      result: { text: "Already ready.", deliveredEarly: true },
    });
  });

  it("awaits in-flight early delivery before exposing the fallback decision", async () => {
    const { runtime } = createAgentRuntime([], {
      blockReplyPayloads: [{ text: '{"spoken":"No duplicate."}' }],
    });
    let finishDelivery: (delivered: boolean) => void = () => {};
    const deliveryFinished = new Promise<boolean>((resolve) => {
      finishDelivery = resolve;
    });
    const onEarlyText = vi.fn(async () => await deliveryFinished);
    let responseSettled = false;

    const response = runGenerateVoiceResponse([], { runtime, onEarlyText }).finally(() => {
      responseSettled = true;
    });
    await vi.waitFor(() => expect(onEarlyText).toHaveBeenCalledOnce());
    expect(responseSettled).toBe(false);

    finishDelivery(true);
    await expect(response).resolves.toEqual({
      result: { text: "No duplicate.", deliveredEarly: true },
    });
  });

  it("combines multiple final-answer items into one early transport handoff", async () => {
    const { runtime } = createAgentRuntime([], {
      blockReplyPayloads: [
        { text: '{"spoken":"First block."}' },
        { text: '{"spoken":"Second block."}' },
      ],
    });
    const delivered: string[] = [];
    const onEarlyText = vi.fn(async (text: string) => {
      delivered.push(text);
      return true;
    });

    const { result } = await runGenerateVoiceResponse([], { runtime, onEarlyText });

    expect(delivered).toEqual(["First block. Second block."]);
    expect(result).toEqual({
      text: "First block. Second block.",
      deliveredEarly: true,
    });
  });

  it("discards pre-tool narration before the completed answer", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
    runEmbeddedAgent.mockImplementationOnce(async (args: EmbeddedAgentArgs) => {
      args.onBlockReply?.({ text: '{"spoken":"I will check."}' }, { assistantMessageIndex: 0 });
      await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
      args.onBlockReply?.(
        { text: '{"spoken":"The result is ready."}' },
        { assistantMessageIndex: 1 },
      );
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      return {
        payloads: [{ text: '{"spoken":"The result is ready."}' }],
        meta: { durationMs: 20_000, aborted: false },
      };
    });
    const onEarlyText = vi.fn(async () => true);

    const { result } = await runGenerateVoiceResponse([], { runtime, onEarlyText });

    expect(onEarlyText).toHaveBeenCalledWith("The result is ready.");
    expect(result).toEqual({ text: "The result is ready.", deliveredEarly: true });
  });

  it("discards deferred pre-tool narration delivered after the tool boundary", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
    runEmbeddedAgent.mockImplementationOnce(async (args: EmbeddedAgentArgs) => {
      await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
      args.onBlockReply?.({ text: '{"spoken":"I will check."}' }, { assistantMessageIndex: 0 });
      args.onBlockReply?.(
        { text: '{"spoken":"The deferred result is ready."}' },
        { assistantMessageIndex: 1 },
      );
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      return {
        payloads: [{ text: '{"spoken":"The deferred result is ready."}' }],
        meta: { durationMs: 20_000, aborted: false },
      };
    });
    const onEarlyText = vi.fn(async () => true);

    const { result } = await runGenerateVoiceResponse([], { runtime, onEarlyText });

    expect(onEarlyText).toHaveBeenCalledWith("The deferred result is ready.");
    expect(result).toEqual({ text: "The deferred result is ready.", deliveredEarly: true });
  });

  it("keeps final delivery when a post-tool payload has no boundary metadata", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
    runEmbeddedAgent.mockImplementationOnce(async (args: EmbeddedAgentArgs) => {
      await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
      args.onBlockReply?.({ text: '{"spoken":"Unclassified response."}' });
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      return {
        payloads: [{ text: '{"spoken":"Complete fallback response."}' }],
        meta: { durationMs: 20_000, aborted: false },
      };
    });
    const onEarlyText = vi.fn(async () => true);

    const { result } = await runGenerateVoiceResponse([], { runtime, onEarlyText });

    expect(onEarlyText).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "Complete fallback response.", deliveredEarly: false });
  });

  it("discards rejected-attempt audio before delivering the accepted retry", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
    runEmbeddedAgent.mockImplementationOnce(async (args: EmbeddedAgentArgs) => {
      args.onBlockReply?.({ text: '{"spoken":"First completed response."}' });
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: false });
      args.onBlockReply?.({ text: '{"spoken":"Retry response."}' });
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      return {
        payloads: [{ text: '{"spoken":"Retry response."}' }],
        meta: { durationMs: 20_000, aborted: false },
      };
    });
    const onEarlyText = vi.fn(async () => true);

    const { result } = await runGenerateVoiceResponse([], { runtime, onEarlyText });

    expect(onEarlyText).toHaveBeenCalledOnce();
    expect(onEarlyText).toHaveBeenCalledWith("Retry response.");
    expect(result).toEqual({
      text: "Retry response.",
      deliveredEarly: true,
    });
  });

  it("resets a rejected attempt tool boundary before the accepted retry", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([]);
    runEmbeddedAgent.mockImplementationOnce(async (args: EmbeddedAgentArgs) => {
      await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
      args.onBlockReply?.(
        { text: '{"spoken":"Rejected tool response."}' },
        { assistantMessageIndex: 1 },
      );
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: false });
      args.onBlockReply?.(
        { text: '{"spoken":"Accepted retry response."}' },
        { assistantMessageIndex: 0 },
      );
      await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
      return {
        payloads: [{ text: '{"spoken":"Accepted retry response."}' }],
        meta: { durationMs: 20_000, aborted: false },
      };
    });
    const onEarlyText = vi.fn(async () => true);

    const { result } = await runGenerateVoiceResponse([], { runtime, onEarlyText });

    expect(onEarlyText).toHaveBeenCalledWith("Accepted retry response.");
    expect(result).toEqual({ text: "Accepted retry response.", deliveredEarly: true });
  });

  it("keeps final delivery enabled when the early transport handoff fails", async () => {
    const { runtime } = createAgentRuntime([], {
      blockReplyPayloads: [
        { text: '{"spoken":"First block."}' },
        { text: '{"spoken":"Try the fallback."}' },
      ],
    });
    const onEarlyText = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(false);

    const { result } = await runGenerateVoiceResponse([], {
      runtime,
      onEarlyText,
    });

    expect(onEarlyText).toHaveBeenCalledWith("First block. Try the fallback.");
    expect(result).toEqual({
      text: "First block. Try the fallback.",
      deliveredEarly: false,
    });
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
    const { runtime, runEmbeddedAgent, patchSessionEntry, sessionStore } = createAgentRuntime([
      { text: '{"spoken":"Pinned model works."}' },
    ]);
    sessionStore["agent:main:voice:15550001111"] = {
      sessionId: "existing-session",
      updatedAt: 100,
      model: "old-model",
      modelProvider: "old-provider",
      contextTokens: 123,
      authProfileOverride: "old-auth-profile",
    };
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
    const pinnedSessionEntry = sessionStore["agent:main:voice:15550001111"];
    expect(pinnedSessionEntry?.providerOverride).toBe("openai");
    expect(pinnedSessionEntry?.modelOverride).toBe("gpt-4.1-nano");
    expect(pinnedSessionEntry?.modelOverrideSource).toBe("auto");
    expect(pinnedSessionEntry?.model).toBeUndefined();
    expect(pinnedSessionEntry?.modelProvider).toBeUndefined();
    expect(pinnedSessionEntry?.contextTokens).toBeUndefined();
    expect(pinnedSessionEntry?.authProfileOverride).toBeUndefined();
    const patchSessionEntryCall = requireFirstMockCall(
      patchSessionEntry.mock.calls,
      "session entry patch",
    );
    expect(patchSessionEntryCall[0]).toMatchObject({
      storePath: "/tmp/openclaw/main/sessions.json",
      sessionKey: "agent:main:voice:15550001111",
      replaceEntry: true,
    });
    expect((patchSessionEntryCall[0] as { update?: unknown }).update).toBeTypeOf("function");
    const args = requireEmbeddedAgentArgs(runEmbeddedAgent);
    expect(args.provider).toBe("openai");
    expect(args.model).toBe("gpt-4.1-nano");
    expect(args.sessionKey).toBe("agent:main:voice:15550001111");
  });

  it("rejects responseModel for a model-locked session without running the embedded agent", async () => {
    const { runtime, runEmbeddedAgent, patchSessionEntry, sessionStore } = createAgentRuntime([]);
    sessionStore["agent:main:voice:15550001111"] = {
      sessionId: "locked-session",
      updatedAt: 100,
      model: "gpt-5.5",
      modelProvider: "openai",
      modelSelectionLocked: true,
    };
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

    expect(result).toEqual({
      text: null,
      deliveredEarly: false,
      error: "Model selection is locked for this session.",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(patchSessionEntry).not.toHaveBeenCalled();
    expect(sessionStore["agent:main:voice:15550001111"]).toMatchObject({
      model: "gpt-5.5",
      modelProvider: "openai",
      modelSelectionLocked: true,
    });
    expect(sessionStore["agent:main:voice:15550001111"]?.modelOverride).toBeUndefined();
  });

  it("propagates the lock for a same-agent supervised Codex session", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
      { text: '{"spoken":"Native Codex continued."}' },
    ]);
    const sessionKey = "agent:main:harness:codex:supervision:019f-codex-thread";
    sessionStore[sessionKey] = {
      sessionId: "catalog-adopted-session",
      updatedAt: 100,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
    };
    const voiceConfig = VoiceCallConfigSchema.parse({ responseTimeoutMs: 5000 });

    const result = await generateVoiceResponse({
      voiceConfig,
      coreConfig: {} as CoreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      sessionKey,
      from: "+15550001111",
      transcript: [{ speaker: "user", text: "continue" }],
      userMessage: "continue",
    });

    expect(result.text).toBe("Native Codex continued.");
    expect(requireEmbeddedAgentArgs(runEmbeddedAgent)).toMatchObject({
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      sessionKey,
    });
  });

  it("canonicalizes a restored legacy per-call key for classic responses", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
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
    const perCallSessionEntry = sessionStore["agent:main:voice:call:call-123"];
    expect(perCallSessionEntry?.sessionId).toBeTypeOf("string");
    expect(perCallSessionEntry?.sessionId).not.toBe("");
    expect(sessionStore["voice:15550001111"]).toBeUndefined();
    const args = requireEmbeddedAgentArgs(runEmbeddedAgent);
    expect(args.sessionKey).toBe("agent:main:voice:call:call-123");
    expect(args.sandboxSessionKey).toBe("agent:main:voice:call:call-123");
  });

  it("preserves an explicit call key while scoping its session-store identity", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
      { text: '{"spoken":"Shared meeting context."}' },
    ]);
    const voiceConfig = VoiceCallConfigSchema.parse({
      agentId: "voice",
      responseTimeoutMs: 5000,
    });

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: {} as CoreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      sessionKey: "meet-room-1",
      from: "+15550001111",
      transcript: [],
      userMessage: "hello there",
    });

    expect(sessionStore["agent:voice:meet-room-1"]?.sessionId).toBeTypeOf("string");
    expect(sessionStore["meet-room-1"]).toBeUndefined();
    expect(requireEmbeddedAgentArgs(runEmbeddedAgent).sessionKey).toBe("agent:voice:meet-room-1");
  });

  it("keeps wrapped foreign Matrix identities stable across restore", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
      { text: '{"spoken":"Matrix context."}' },
    ]);
    const voiceConfig = VoiceCallConfigSchema.parse({
      agentId: "voice",
      responseTimeoutMs: 5000,
    });
    const canonical = "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org";
    const generate = (sessionKey: string) =>
      generateVoiceResponse({
        voiceConfig,
        coreConfig: {} as CoreConfig,
        agentRuntime: runtime,
        callId: "call-123",
        sessionKey,
        from: "+15550001111",
        transcript: [],
        userMessage: "hello there",
      });

    await generate("agent:other:matrix:channel:!RoomAbC:example.org");
    await generate(canonical);
    await generate("agent:other:matrix:channel:!Roomabc:example.org");

    expect(sessionStore[canonical]?.sessionId).toBeTypeOf("string");
    expect(
      sessionStore["agent:voice:agent:other:matrix:channel:!Roomabc:example.org"]?.sessionId,
    ).toBeTypeOf("string");
    expect(Object.keys(sessionStore)).toHaveLength(2);
    const sessionKeys = runEmbeddedAgent.mock.calls.map(([args]) => args.sessionKey);
    expect(sessionKeys).toEqual([
      canonical,
      canonical,
      "agent:voice:agent:other:matrix:channel:!Roomabc:example.org",
    ]);
  });

  it("uses the configured core main key for restored call aliases", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime([
      { text: '{"spoken":"Main context."}' },
    ]);
    const voiceConfig = VoiceCallConfigSchema.parse({
      agentId: "voice",
      responseTimeoutMs: 5000,
    });

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: { session: { mainKey: "work" } },
      agentRuntime: runtime,
      callId: "call-123",
      sessionKey: "agent:voice:main",
      from: "+15550001111",
      transcript: [],
      userMessage: "hello there",
    });

    expect(sessionStore["agent:voice:work"]?.sessionId).toBeTypeOf("string");
    expect(requireEmbeddedAgentArgs(runEmbeddedAgent).sessionKey).toBe("agent:voice:work");
  });

  it("uses the main agent workspace when voice config omits agentId", async () => {
    const {
      runtime,
      runEmbeddedAgent,
      resolveAgentDir,
      resolveAgentWorkspaceDir,
      resolveAgentIdentity,
      resolveStorePath,
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
    const defaultSessionEntry = sessionStore["agent:main:voice:15550001111"];
    if (!defaultSessionEntry) {
      throw new Error("Expected default voice session entry");
    }
    const args = requireEmbeddedAgentArgs(runEmbeddedAgent);
    expect(args.agentDir).toBe("/tmp/openclaw/agents/main");
    expect(args.agentId).toBe("main");
    expect(args.sessionKey).toBe("agent:main:voice:15550001111");
    expect(args.sessionTarget).toStrictEqual({
      agentId: "main",
      sessionId: defaultSessionEntry.sessionId,
      sessionKey: "agent:main:voice:15550001111",
      storePath: "/tmp/openclaw/main/sessions.json",
    });
    expect(args.sandboxSessionKey).toBe("agent:main:voice:15550001111");
    expect(args.workspaceDir).toBe("/tmp/openclaw/workspace/main");
    expect(args.sessionFile).toBeUndefined();
  });

  it("uses the configured voice response agent workspace", async () => {
    const {
      runtime,
      runEmbeddedAgent,
      resolveAgentDir,
      resolveAgentWorkspaceDir,
      resolveAgentIdentity,
      resolveStorePath,
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
    const voiceSessionEntry = sessionStore["agent:voice:voice:15550001111"];
    if (!voiceSessionEntry) {
      throw new Error("Expected routed voice session entry");
    }
    const args = requireEmbeddedAgentArgs(runEmbeddedAgent);
    expect(args.agentDir).toBe("/tmp/openclaw/agents/voice");
    expect(args.agentId).toBe("voice");
    expect(args.sessionKey).toBe("agent:voice:voice:15550001111");
    expect(args.sessionTarget).toStrictEqual({
      agentId: "voice",
      sessionId: voiceSessionEntry.sessionId,
      sessionKey: "agent:voice:voice:15550001111",
      storePath: "/tmp/openclaw/voice/sessions.json",
    });
    expect(args.sandboxSessionKey).toBe("agent:voice:voice:15550001111");
    expect(args.workspaceDir).toBe("/tmp/openclaw/workspace/voice");
    expect(args.sessionFile).toBeUndefined();
  });

  it("prefers the agent frozen on the call", async () => {
    const { runtime, runEmbeddedAgent, resolveStorePath } = createAgentRuntime([
      { text: '{"spoken":"Support agent."}' },
    ]);

    await generateVoiceResponse({
      voiceConfig: VoiceCallConfigSchema.parse({ agentId: "voice", responseTimeoutMs: 5000 }),
      coreConfig: {} as CoreConfig,
      agentRuntime: runtime,
      callId: "call-123",
      agentId: "support",
      sessionKey: "agent:support:google-meet:meet-1",
      from: "+15550001111",
      transcript: [],
      userMessage: "hello there",
    });

    expect(resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "support" });
    expect(requireEmbeddedAgentArgs(runEmbeddedAgent)).toMatchObject({
      agentId: "support",
      sessionKey: "agent:support:google-meet:meet-1",
    });
  });

  it("passes the routed voice agent explicit tool allowlist to the embedded run", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([
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
    const args = requireEmbeddedAgentArgs(runEmbeddedAgent);
    expect(args.agentId).toBe("voice");
    expect(args.toolsAllow).toStrictEqual([]);
  });
});
