// Tests get-reply behavior while probing an auto-fallback primary model.
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { ThinkLevel } from "../thinking.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
}

function emptyAliasIndex() {
  return { byAlias: new Map(), byKey: new Map() };
}

function makeTestModel(id: string, name: string, reasoning: boolean): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function makeReasoningModelConfig(): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  } satisfies OpenClawConfig);
}

function makePerAgentThinkingOffConfig(): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
      },
      list: [
        {
          id: "main",
          thinkingDefault: "off",
        },
      ],
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  } satisfies OpenClawConfig);
}

function makePerModelThinkingConfig(
  thinking: false | "disabled" | "none" | "high",
): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
        models: {
          "openai/gpt-5.5": {
            params: { thinking },
          },
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  } satisfies OpenClawConfig);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function mockAutoFallbackSession(params: { modelSelectionLocked?: boolean } = {}) {
  const sessionKey = "agent:main:telegram:123";
  const sessionEntry: SessionEntry = {
    sessionId: "fallback-session",
    updatedAt: Date.now(),
    providerOverride: "anthropic",
    modelOverride: "claude-fallback",
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: "openai",
    modelOverrideFallbackOriginModel: "gpt-5.5",
    modelSelectionLocked: params.modelSelectionLocked,
  };
  // Reply-turn admission re-reads the canonical SQLite store before starting
  // work; seed a real per-test store so the guard sees the same session the
  // mocks describe instead of depending on leftover host state.
  const storePath = path.join(tempDirs.make("auto-fallback-store"), "sessions.json");
  replaceSessionEntrySync({ storePath, sessionKey }, sessionEntry);
  mocks.initSessionState.mockResolvedValue(
    createGetReplySessionState({
      sessionKey,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      storePath,
      triggerBodyNormalized: "hello",
      bodyStripped: "hello",
    }),
  );
  return { sessionKey };
}

function mockFallbackDirectiveResult(params: {
  sessionKey: string;
  resolvedThinkLevel?: ThinkLevel;
  resolvedReasoningLevel?: "off" | "on";
}) {
  mocks.resolveReplyDirectives.mockImplementation(async () =>
    createGetReplyContinueDirectivesResult({
      body: "hello",
      abortKey: params.sessionKey,
      from: "telegram:user:42",
      to: "telegram:123",
      senderId: "telegram:user:42",
      commandSource: "text",
      senderIsOwner: true,
      resetHookTriggered: false,
      provider: "anthropic",
      model: "claude-fallback",
      resolvedThinkLevel: params.resolvedThinkLevel,
      resolvedReasoningLevel: params.resolvedReasoningLevel,
    }),
  );
}

describe("getReplyFromConfig auto-fallback primary probes", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.OPENCLAW_TEST_FAST;
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(resolveDefaultModelMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockReset();

    vi.mocked(resolveDefaultModelMock).mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: emptyAliasIndex(),
    });
    mocks.handleInlineActions.mockImplementation(async (params: unknown) => ({
      kind: "continue",
      directives: (params as { directives?: unknown }).directives ?? {},
      cleanedBody: (params as { cleanedBody?: string }).cleanedBody ?? "hello",
      abortedLastRun: false,
    }));
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
  });

  it("does not probe the primary model for a model-locked session", async () => {
    const { sessionKey } = mockAutoFallbackSession({ modelSelectionLocked: true });
    mockFallbackDirectiveResult({ sessionKey, resolvedThinkLevel: "off" });

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makeReasoningModelConfig()),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("anthropic");
    expect(runParams?.model).toBe("claude-fallback");
    expect(runParams?.autoFallbackPrimaryProbe).toBeUndefined();
  });

  it("suppresses heartbeat model overrides for a model-locked session", async () => {
    const { sessionKey } = mockAutoFallbackSession({ modelSelectionLocked: true });
    mockFallbackDirectiveResult({ sessionKey, resolvedThinkLevel: "off" });

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx(),
        { isHeartbeat: true, heartbeatModelOverride: "openai/gpt-5.5" },
        makeReasoningModelConfig(),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-fallback",
      hasResolvedHeartbeatModelOverride: false,
    });
  });

  it("does not re-enable default reasoning for explicit thinking-off primary probes", async () => {
    const { sessionKey } = mockAutoFallbackSession();
    mockFallbackDirectiveResult({ sessionKey, resolvedThinkLevel: "off" });

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx(),
        { thinkingLevelOverride: "off" },
        makeReasoningModelConfig(),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("off");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it("uses primary model thinking defaults for invalid thinking override primary probes", async () => {
    const { sessionKey } = mockAutoFallbackSession();
    mockFallbackDirectiveResult({ sessionKey, resolvedThinkLevel: "off" });

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx(),
        { thinkingLevelOverride: "not-a-level" },
        makeReasoningModelConfig(),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("medium");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it("does not re-enable default reasoning for per-agent thinking-off primary probes", async () => {
    const { sessionKey } = mockAutoFallbackSession();
    mockFallbackDirectiveResult({ sessionKey, resolvedThinkLevel: "off" });

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makePerAgentThinkingOffConfig()),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("off");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it.each([false, "disabled", "none"] as const)(
    "does not re-enable default reasoning for per-model thinking-off primary probes (%s)",
    async (thinking) => {
      const { sessionKey } = mockAutoFallbackSession();
      mockFallbackDirectiveResult({ sessionKey, resolvedThinkLevel: "off" });

      await expect(
        getReplyFromConfig(buildGetReplyCtx(), undefined, makePerModelThinkingConfig(thinking)),
      ).resolves.toEqual({ text: "ok" });

      expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
      const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
      expect(runParams?.provider).toBe("openai");
      expect(runParams?.model).toBe("gpt-5.5");
      expect(runParams?.resolvedThinkLevel).toBe("off");
      expect(runParams?.resolvedReasoningLevel).toBe("off");
    },
  );

  it("clears stale fallback reasoning for per-model thinking-off primary probes", async () => {
    const { sessionKey } = mockAutoFallbackSession();
    mockFallbackDirectiveResult({
      sessionKey,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "on",
    });

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makePerModelThinkingConfig(false)),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("off");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it("recomputes per-model thinking defaults for primary probes", async () => {
    const { sessionKey } = mockAutoFallbackSession();
    mockFallbackDirectiveResult({ sessionKey, resolvedThinkLevel: "off" });

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makePerModelThinkingConfig("high")),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("high");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it("clears stale fallback reasoning when primary probe thinking is active", async () => {
    const { sessionKey } = mockAutoFallbackSession();
    mockFallbackDirectiveResult({
      sessionKey,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "on",
    });

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makePerModelThinkingConfig("high")),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("high");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });
});
