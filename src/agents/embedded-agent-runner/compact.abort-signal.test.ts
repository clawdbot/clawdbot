import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

vi.mock("../model-fallback.js", () => ({
  resolveModelCandidateChain: (params: { provider: string; model: string }) => [
    { provider: params.provider, model: params.model },
  ],
  runWithModelFallback: vi.fn(async (params: Record<string, unknown>) => ({
    result: { ok: true, compacted: false, reason: "no-op" },
    provider: params.provider,
    model: params.model,
    attempts: [],
  })),
  isFallbackSummaryError: () => false,
}));

vi.mock("./compact.queued.js", () => ({ compactEmbeddedAgentSession: vi.fn() }));

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
        createStores: () => ({}),
      },
      release: vi.fn(),
    }),
  ),
}));

import { runWithModelFallback } from "../model-fallback.js";
import { compactEmbeddedAgentSessionDirect } from "./compact.js";

const runMock = vi.mocked(runWithModelFallback);

const baseParams = {
  sessionId: "test-session",
  sessionKey: "agent:main:test-session",
  sessionFile: "/tmp/test-session.jsonl",
  workspaceDir: "/tmp",
};

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
  });

  it("forwards params.abortSignal to runWithModelFallback so terminal aborts during compaction short-circuit", async () => {
    const controller = new AbortController();

    await compactEmbeddedAgentSessionDirect({
      ...baseParams,
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
      ...baseParams,
      config: configWithFallbacks(["anthropic/claude-haiku-4-5"]),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    const passedParams = runMock.mock.calls[0]?.[0];
    expect(passedParams?.abortSignal).toBeUndefined();
  });
});
