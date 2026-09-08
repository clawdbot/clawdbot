// Proves the pinned fallback decision survives the complete reply-entry path.
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import {
  makeModelFallbackConfig,
  withModelFallbackWorkspace,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const emptyPluginRegistry = createEmptyPluginRegistry();
const suspendSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

function installReplyEntryMocks() {
  vi.doMock("../plugins/runtime.js", () => ({
    getActivePluginRegistry: () => null,
    getActivePluginRegistryWorkspaceDir: () => undefined,
    getPluginRegistryForContext: () => emptyPluginRegistry,
    requireActivePluginRegistry: () => emptyPluginRegistry,
  }));
  vi.doMock("./harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
  }));
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  vi.doMock("./session-suspension.js", async () => {
    const actual =
      await vi.importActual<typeof import("./session-suspension.js")>("./session-suspension.js");
    return { ...actual, suspendSession: suspendSessionMock };
  });
}

let getReplyFromConfig: typeof import("../auto-reply/reply/get-reply.js").getReplyFromConfig;
let withFullRuntimeReplyConfig: typeof import("../auto-reply/reply/get-reply-fast-path.js").withFullRuntimeReplyConfig;
const RATE_LIMIT_ERROR_MESSAGE = "rate limit exceeded";

beforeAll(async () => {
  installReplyEntryMocks();
  ({ getReplyFromConfig } = await import("../auto-reply/reply/get-reply.js"));
  ({ withFullRuntimeReplyConfig } = await import("../auto-reply/reply/get-reply-fast-path.js"));
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  resetFallbackSkipCacheForTest();
  runEmbeddedAttemptMock.mockReset();
  suspendSessionMock.mockClear();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

function countProviderAttempts(provider: string): number {
  return runEmbeddedAttemptMock.mock.calls.filter(
    (call) => (call[0] as { provider?: string })?.provider === provider,
  ).length;
}

describe("getReplyFromConfig fallback availability", () => {
  it("returns the pinned rate-limit surface through the reply entry", async () => {
    // Pre-fix this chain returned "The AI service is temporarily rate-limited. Please try again
    // in a moment." because run preparation rebuilt fallbackConfigured from config defaults instead
    // of carrying the disabled model-fallback availability into the embedded runner.
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);
      const baseConfig = makeModelFallbackConfig();
      const groqProvider = baseConfig.models?.providers?.groq;
      if (!groqProvider) {
        throw new Error("expected fallback provider fixture");
      }
      const sessionKey = "agent:test:telegram:111";
      const storePath = path.join(path.dirname(agentDir), "sessions.json");
      const cfg: OpenClawConfig = {
        ...baseConfig,
        agents: {
          ...baseConfig.agents,
          defaults: {
            ...baseConfig.agents?.defaults,
            workspace: workspaceDir,
            model: { primary: "openai/mock-1", fallbacks: ["anthropic/mock-2"] },
          },
          list: [{ id: "test", agentDir, workspace: workspaceDir }],
        },
        models: {
          ...baseConfig.models,
          providers: {
            ...baseConfig.models?.providers,
            anthropic: { ...groqProvider, baseUrl: "https://example.com/anthropic" },
          },
        },
        session: { store: storePath },
      };
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "session-pinned-rate-limit",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "mock-1",
          modelOverrideSource: "user",
        },
      );
      runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
        const attemptParams = params as { provider: string; modelId?: string };
        if (attemptParams.provider !== "openai") {
          throw new Error(`unexpected fallback attempt: ${attemptParams.provider}`);
        }
        return makeEmbeddedRunnerAttempt({
          assistantTexts: [],
          lastAssistant: buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: attemptParams.modelId ?? "mock-1",
            stopReason: "error",
            errorMessage: RATE_LIMIT_ERROR_MESSAGE,
          }),
        });
      });

      const ctx: MsgContext = {
        Body: "hello",
        From: "telegram:111",
        To: "telegram:111",
        ChatType: "direct",
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: sessionKey,
        CommandAuthorized: true,
      };
      const replyConfig = withFullRuntimeReplyConfig(cfg);
      setRuntimeConfigSnapshot(replyConfig, replyConfig);
      let result: Awaited<ReturnType<typeof getReplyFromConfig>>;
      try {
        result = await getReplyFromConfig(ctx, undefined, replyConfig);
      } finally {
        clearRuntimeConfigSnapshot();
      }
      const text = Array.isArray(result) ? result[0]?.text : result?.text;
      expect(countProviderAttempts("openai")).toBeGreaterThan(2);
      expect(countProviderAttempts("anthropic")).toBe(0);
      expect(text).toContain("API rate limit reached");
    });
  });
});
