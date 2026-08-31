import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

vi.mock("../model-fallback-candidates.js", () => ({
  resolveModelCandidateChain: (params: { provider: string; model: string }) => [
    { provider: params.provider, model: params.model },
  ],
}));

vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: vi.fn(async (params: Record<string, unknown>) => ({
    result: { ok: true, compacted: false, reason: "no-op" },
    provider: params.provider,
    model: params.model,
    attempts: [],
  })),
}));

vi.mock("../model-fallback-attempt.js", () => ({
  isFallbackSummaryError: () => false,
}));

vi.mock("./compact.queued.js", () => ({ compactEmbeddedAgentSession: vi.fn() }));

vi.mock("./direct-compaction.js", () => ({
  compactEmbeddedAgentSessionDirectOnce: vi.fn(async () => ({
    ok: true,
    compacted: false,
    reason: "no-op",
  })),
}));

vi.mock("../prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: vi.fn(
    async (input: {
      config: OpenClawConfig;
      agentId?: string;
      agentDir: string;
      workspaceDir?: string;
    }) => ({
      snapshot: {
        config: input.config,
        agentId: input.agentId,
        agentDir: input.agentDir,
        workspaceDir: input.workspaceDir,
        metadataSnapshot: {
          plugins: [
            {
              id: "byteplus",
              origin: "bundled",
              providerAuthAliases: { "byteplus-plan": "byteplus" },
            },
          ],
        },
        createStores: () => ({}),
      },
      release: vi.fn(),
    }),
  ),
}));

import { runWithModelFallback } from "../model-fallback-runner.js";
import { compactEmbeddedAgentSessionDirect } from "./compact.js";
import { compactEmbeddedAgentSessionDirectOnce } from "./direct-compaction.js";

const runMock = vi.mocked(runWithModelFallback);
const compactOnceMock = vi.mocked(compactEmbeddedAgentSessionDirectOnce);

function baseParams() {
  const workspaceDir = tempDirs.make("openclaw-compact-abort-");
  return {
    sessionId: "test-session",
    sessionKey: "agent:main:test-session",
    sessionFile: "agent:main:test-session",
    sessionTarget: {
      agentId: "main",
      sessionId: "test-session",
      sessionKey: "agent:main:test-session",
      storePath: join(workspaceDir, "sessions.json"),
    },
    workspaceDir,
  };
}

function configWithFallbacks(fallbacks: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks,
        },
      },
    },
  } as OpenClawConfig;
}

describe("compactEmbeddedAgentSessionDirect abortSignal threading", () => {
  beforeEach(() => {
    runMock.mockClear();
    compactOnceMock.mockClear();
  });

  it("forwards params.abortSignal to runWithModelFallback so terminal aborts during compaction short-circuit", async () => {
    const controller = new AbortController();

    await compactEmbeddedAgentSessionDirect({
      ...baseParams(),
      config: configWithFallbacks(["anthropic/claude-haiku-4-5", "openai/gpt-4.1-mini"]),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      abortSignal: controller.signal,
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    const passedParams = runMock.mock.calls[0]?.[0];
    expect(passedParams?.abortSignal).toBe(controller.signal);
  });

  it("passes undefined when no abortSignal is set (back-compat)", async () => {
    await compactEmbeddedAgentSessionDirect({
      ...baseParams(),
      config: configWithFallbacks(["anthropic/claude-haiku-4-5"]),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    const passedParams = runMock.mock.calls[0]?.[0];
    expect(passedParams?.abortSignal).toBeUndefined();
  });

  it.each([
    { source: "user" as const, expected: "anthropic:work" },
    { source: "auto" as const, expected: undefined },
  ])("forwards only $source auth profiles as user locks", async ({ source, expected }) => {
    await compactEmbeddedAgentSessionDirect({
      ...baseParams(),
      config: configWithFallbacks(["anthropic/claude-haiku-4-5"]),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      authProfileId: "anthropic:work",
      authProfileIdSource: source,
    });

    expect(runMock.mock.calls[0]?.[0]?.userLockedAuthProfileId).toBe(expected);
  });

  it("preserves a user auth pin across BytePlus compaction fallback aliases", async () => {
    await compactEmbeddedAgentSessionDirect({
      ...baseParams(),
      config: configWithFallbacks(["byteplus-plan/ark-code-latest"]),
      provider: "byteplus",
      model: "dola-seed-2-1-turbo-260628",
      authProfileId: "byteplus:work",
      authProfileIdSource: "user",
    });

    const fallbackRun = runMock.mock.calls[0]?.[0]?.run;
    expect(fallbackRun).toBeTypeOf("function");
    await fallbackRun?.("byteplus-plan", "ark-code-latest");

    expect(compactOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "byteplus-plan",
        model: "ark-code-latest",
        authProfileId: "byteplus:work",
        authProfileIdSource: "user",
        runtimeAuthPlan: undefined,
        runtimePlan: undefined,
      }),
    );
  });
});
