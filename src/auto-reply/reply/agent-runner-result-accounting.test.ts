import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";

const mocks = vi.hoisted(() => ({
  persistSessionUsageUpdate: vi.fn(async (_params: unknown) => undefined),
  refreshQueuedFollowupSession: vi.fn(),
  resolveContextTokenBudgetForModel: vi.fn<
    (params?: {
      cfg?: unknown;
      provider?: string;
      model?: string;
      allowAsyncLoad?: boolean;
      allowUnscopedModelLookup?: boolean;
    }) => Promise<
      { contextTokens: number; source: "model" | "configured" | "fallback" } | undefined
    >
  >(async () => ({ contextTokens: 200_000, source: "configured" })),
}));

vi.mock("../../agents/context.js", () => ({
  resolveContextTokenBudgetForModel: (params?: {
    cfg?: unknown;
    provider?: string;
    model?: string;
  }) => mocks.resolveContextTokenBudgetForModel(params),
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

vi.mock("../../agents/model-selection.js", () => ({
  isCliProvider: () => false,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: vi.fn(async () => {}),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../sessions/input-provenance.js", () => ({
  shouldPreserveUserFacingSessionStateForInputProvenance: () => false,
}));

vi.mock("../fallback-state.js", () => ({
  resolveFallbackTransition: () => ({
    stateChanged: true,
    nextState: {
      selectedModel: "anthropic/claude",
      activeModel: "openai/gpt-4o",
      reason: "rate limit",
    },
  }),
}));

vi.mock("./agent-runner-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-core.js")>()),
  resolveFallbackOriginModel: () => ({
    provider: "anthropic",
    model: "claude",
  }),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) => mocks.refreshQueuedFollowupSession(...args),
}));

vi.mock("./reply-usage-state.js", () => ({
  buildReplyUsageState: () => ({}),
  recordReplyUsageState: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(async () => undefined),
}));

vi.mock("./session-usage.js", () => ({
  persistSessionUsageUpdate: (params: unknown) => mocks.persistSessionUsageUpdate(params),
}));

import { accountFollowupTurn } from "./agent-runner-result-accounting.js";

function createParams(
  authProfileOverrideCompactionCount?: number,
): Parameters<typeof accountFollowupTurn>[0] {
  let entry: SessionEntry = {
    sessionId: "session-1",
    updatedAt: 1,
    authProfileOverride: "openai:work",
    ...(authProfileOverrideCompactionCount === undefined
      ? {}
      : { authProfileOverrideCompactionCount }),
  };
  const sessionStore = { main: entry };
  const turn = {
    runId: "run-1",
    queued: {
      prompt: "queued prompt",
      enqueuedAt: 1,
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session-1",
        sessionKey: "main",
        sessionFile: "main",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {},
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => entry,
      publish: (next: SessionEntry | undefined) => {
        if (next) {
          entry = next;
          sessionStore.main = next;
        }
      },
      adopt: (next: SessionEntry) => {
        entry = next;
        sessionStore.main = next;
      },
    },
    sessionStore,
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  } as unknown as AdmittedFollowupTurn;
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "claude",
    sessionKey: "main",
  } satisfies FollowupRunnerParams;
  const execution = {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "run-1",
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "openai", model: "gpt-4o" },
        fallback: {
          exhausted: false,
          attempts: [
            {
              provider: "anthropic",
              model: "claude",
              error: "rate limited",
              reason: "rate_limit",
            },
          ],
        },
        autoCompactionCount: 0,
        didLogHeartbeatStrip: false,
      },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: {
      drain: vi.fn(async () => {}),
    },
  } as FollowupExecutionResult;
  return { turn, defaults, execution };
}

describe("accountFollowupTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveContextTokenBudgetForModel.mockResolvedValue({
      contextTokens: 200_000,
      source: "configured",
    });
  });

  it("forwards typed runtime context provenance to session persistence", async () => {
    const params = createParams();
    const result = params.execution.execution.outcome;
    if (result.kind !== "settled") {
      throw new Error("expected settled test execution");
    }
    result.result.meta.agentMeta = {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4o",
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    };

    await accountFollowupTurn(params);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "codex",
        contextTokensUsed: 1_000_000,
        contextTokensSource: "runtime",
      }),
    );
  });

  it("treats a source-less current-run context window as runtime provenance", async () => {
    const params = createParams();
    const result = params.execution.execution.outcome;
    if (result.kind !== "settled") {
      throw new Error("expected settled test execution");
    }
    result.result.meta.agentMeta = {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4o",
      agentHarnessId: "legacy-runtime",
      contextTokens: 512_000,
    };

    await accountFollowupTurn(params);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "legacy-runtime",
        contextTokensUsed: 512_000,
        contextTokensSource: "runtime",
      }),
    );
  });

  it("marks a model-owned resolution with versioned resolved provenance", async () => {
    mocks.resolveContextTokenBudgetForModel.mockResolvedValue({
      contextTokens: 120_000,
      source: "model",
    });
    const runParams = createParams();

    await accountFollowupTurn(runParams);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokensUsed: 120_000,
        contextTokensSource: "resolved-v1",
      }),
    );
  });

  it("keeps a config-only resolution on the untrusted legacy tag", async () => {
    const runParams = createParams();

    await accountFollowupTurn(runParams);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokensUsed: 200_000,
        contextTokensSource: "resolved",
      }),
    );
  });

  it("preserves an exact persisted resolution when current model resolution is unavailable", async () => {
    mocks.resolveContextTokenBudgetForModel.mockResolvedValue(undefined);
    const params = createParams();
    const session = params.turn.session as unknown as {
      current: () => SessionEntry;
      adopt: (entry: SessionEntry) => void;
    };
    session.adopt({
      ...session.current(),
      modelProvider: "openai",
      model: "gpt-4o",
      agentHarnessId: "openclaw",
      contextTokens: 272_000,
      contextTokensSource: "resolved-v1",
    });
    const result = params.execution.execution.outcome;
    if (result.kind !== "settled") {
      throw new Error("expected settled test execution");
    }
    result.result.meta.agentMeta = {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4o",
      agentHarnessId: "openclaw",
    };

    await accountFollowupTurn(params);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokensUsed: 272_000,
        contextTokensSource: "resolved-v1",
      }),
    );
    expect(mocks.resolveContextTokenBudgetForModel).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnscopedModelLookup: false }),
    );
  });

  it("does not label a prior context fallback as a current resolution after a model switch", async () => {
    mocks.resolveContextTokenBudgetForModel.mockResolvedValue(undefined);
    const params = createParams();
    const session = params.turn.session as unknown as {
      current: () => SessionEntry;
      adopt: (entry: SessionEntry) => void;
    };
    session.adopt({
      ...session.current(),
      modelProvider: "anthropic",
      model: "claude",
      agentHarnessId: "openclaw",
      contextTokens: 272_000,
      contextTokensSource: "resolved",
    });
    const result = params.execution.execution.outcome;
    if (result.kind !== "settled") {
      throw new Error("expected settled test execution");
    }
    result.result.meta.agentMeta = {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4o",
      agentHarnessId: "codex",
    };

    await accountFollowupTurn(params);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerUsed: "openai",
        modelUsed: "gpt-4o",
        agentHarnessId: "codex",
        contextTokensUsed: 272_000,
        contextTokensSource: undefined,
      }),
    );
  });

  it.each([
    {
      name: "source-less legacy user pin",
      authProfileOverrideCompactionCount: undefined,
      expectedSource: "user",
    },
    {
      name: "source-less compaction-marked auto pin",
      authProfileOverrideCompactionCount: 0,
      expectedSource: "auto",
    },
  ] as const)(
    "forwards a $name with canonical provenance during fallback queue refresh",
    async ({ authProfileOverrideCompactionCount, expectedSource }) => {
      await accountFollowupTurn(createParams(authProfileOverrideCompactionCount));

      expect(mocks.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
      expect(mocks.refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "main",
          nextProvider: "openai",
          nextModel: "gpt-4o",
          nextAuthProfileId: "openai:work",
          nextAuthProfileIdSource: expectedSource,
        }),
      );
    },
  );
});
