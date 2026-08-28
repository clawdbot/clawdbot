import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { EmbeddedAgentMeta } from "../../agents/embedded-agent-runner/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { forgetActiveSessionForShutdown } from "../../gateway/active-sessions-shutdown-tracker.js";
import { accountAgentTurn, accountFollowupTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import { incrementRunCompactionCount } from "./session-run-accounting.js";
import {
  createMockFollowupRun,
  createMockReplyOperation,
  createMockTypingController,
} from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => forgetActiveSessionForShutdown("context-pressure-successor"));
const diagnostic = {
  schemaVersion: 1,
  source: "pre-prompt-estimate",
  updatedAt: 20,
  provider: "openai",
  model: "gpt-5.6-luna",
  route: "compact_only",
  shouldCompact: true,
  estimatedPromptTokens: 950,
  contextTokenBudget: 1_000,
  promptBudgetBeforeReserve: 900,
  reserveTokens: 100,
  effectiveReserveTokens: 100,
  remainingPromptBudgetTokens: 0,
  overflowTokens: 50,
  toolResultReducibleChars: 0,
  messageCount: 4,
  unwindowedMessageCount: 4,
} satisfies NonNullable<SessionEntry["contextBudgetStatus"]>;

async function createFixture() {
  const root = tempDirs.make("openclaw-context-pressure-");
  const storePath = path.join(root, "sessions.json");
  const sessionKey = "agent:main:main";
  const entry: SessionEntry = {
    sessionId: "session",
    lifecycleRevision: "generation-1",
    updatedAt: 1,
    modelProvider: diagnostic.provider,
    model: diagnostic.model,
    contextBudgetStatus: { ...diagnostic, updatedAt: 1 },
    estimatedCostUsd: 2,
  };
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    models: {
      providers: {
        openai: {
          baseUrl: "https://unused.invalid",
          models: [
            {
              id: diagnostic.model,
              name: "test model",
              reasoning: false,
              input: ["text"],
              contextWindow: 1_000,
              maxTokens: 100,
              cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
            },
          ],
        },
      },
    },
  };
  const followupRun = createMockFollowupRun({
    run: {
      sessionKey,
      sessionId: entry.sessionId,
      agentDir: root,
      workspaceDir: root,
      config: cfg,
      provider: diagnostic.provider,
      model: diagnostic.model,
    },
  });
  const sessionStore = { [sessionKey]: entry };
  const context: FinalizeReplyAgentRunInput = {
    activeIsNewSession: false,
    activeSessionEntry: entry,
    activeSessionStore: sessionStore,
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    cfg,
    commandBody: followupRun.prompt,
    defaultModel: diagnostic.model,
    followupRun,
    isHeartbeat: false,
    pendingToolTasks: new Set(),
    preflightCompactionApplied: false,
    queueKey: sessionKey,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    replyOperation: createMockReplyOperation().replyOperation,
    replyRouteThreadId: undefined,
    replyToChannel: undefined,
    replyToMode: "off",
    resolvedBlockStreamingBreak: "message_end",
    resolvedQueue: { mode: "followup" },
    resolvedVerboseLevel: "off",
    returnWithQueuedFollowupDrain: (value) => value,
    runFollowupTurn: async () => {},
    execution: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 1,
          requestShaping: { authMode: "api-key", fallbackEligible: false },
        },
      },
      resolved: { provider: diagnostic.provider, model: diagnostic.model },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
    runId: "context-pressure-run",
    runStartedAt: Date.now(),
    sessionCtx: {},
    sessionKey,
    shouldInjectGroupIntro: false,
    storePath,
    typingSignals: createTypingSignaler({
      typing: createMockTypingController(),
      mode: "never",
      isHeartbeat: false,
    }),
  };
  const handle = createReplySessionEntryHandle({
    sessionEntry: entry,
    sessionStore,
    sessionKey,
    generationFence: { sessionId: entry.sessionId, expectedStoreEntry: entry },
  });
  const turn: AdmittedFollowupTurn = {
    runId: context.runId,
    queued: followupRun,
    operation: context.replyOperation,
    config: cfg,
    session: {
      kind: "session",
      key: sessionKey,
      storePath,
      current: () => handle.getCurrent(),
      publish: (next) => next && handle.replaceCurrent(next),
      adopt: (next) => handle.adoptCurrent(next),
    },
    sessionStore: handle.toCompatSessionStore(),
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
  return {
    context,
    read: () => loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
    replace: (next: SessionEntry) => replaceSessionEntry({ storePath, sessionKey }, next),
    account: async (lane: "ordinary" | "followup", meta: Partial<EmbeddedAgentMeta>) => {
      context.execution.result.meta.agentMeta = {
        sessionId: entry.sessionId,
        provider: diagnostic.provider,
        model: diagnostic.model,
        contextTokens: 1_000,
        contextBudgetStatus: diagnostic,
        ...meta,
      };
      if (lane === "ordinary") {
        const accounting = await accountAgentTurn(context);
        await completeReplyAgentRun({
          context,
          accounting,
          prepared: {
            kind: "continue",
            activeSessionEntry: accounting.activeSessionEntry,
            // The reply was already delivered; exercise completion bookkeeping
            // without creating another pending delivery intent.
            completedSourceReplyDelivery: true,
            guardedReplyPayloads: [],
            responseUsageLine: undefined,
          },
        });
      } else {
        turn.preflightCompactionApplied = context.preflightCompactionApplied === true;
        await accountFollowupTurn({
          turn,
          defaults: {
            defaultModel: diagnostic.model,
            typing: createMockTypingController(),
            typingMode: "never",
            opts: { isHeartbeat: context.isHeartbeat },
          },
          execution: {
            commentaryPayloadsEnabled: false,
            execution: { runId: context.runId, outcome: context.execution },
            runStartedAt: context.runStartedAt,
            sessionCtx: {},
            pendingToolTasks: context.pendingToolTasks,
            progress: { drain: async () => {} },
          },
        });
      }
    },
  };
}

describe.each(["ordinary", "followup"] as const)("%s context-pressure accounting", (lane) => {
  it.each([
    { name: "new diagnostic with usage", withUsage: true, contextBudgetStatus: diagnostic },
    { name: "new diagnostic without usage", withUsage: false, contextBudgetStatus: diagnostic },
    { name: "missing diagnostic with usage", withUsage: true, contextBudgetStatus: undefined },
    { name: "missing diagnostic without usage", withUsage: false, contextBudgetStatus: undefined },
  ])(
    "persists $name without changing token/cost accounting",
    async ({ withUsage, contextBudgetStatus }) => {
      const fixture = await createFixture();
      const usage = withUsage ? { input: 120, output: 8, cacheRead: 20 } : undefined;
      const meta = { usage, lastCallUsage: usage, contextBudgetStatus };
      await fixture.account(lane, meta);
      expect(fixture.read()?.contextBudgetStatus).toEqual(contextBudgetStatus);
      expect(fixture.read()).toMatchObject(
        withUsage
          ? {
              inputTokens: 120,
              outputTokens: 8,
              cacheRead: 20,
              totalTokens: 140,
              totalTokensFresh: true,
              estimatedCostUsd: 0.000146,
            }
          : { totalTokensFresh: false, estimatedCostUsd: 2 },
      );
    },
  );

  it.each([
    { mode: "heartbeat", withUsage: true },
    { mode: "heartbeat", withUsage: false },
    { mode: "exhausted fallback", withUsage: true },
    { mode: "exhausted fallback", withUsage: false },
    { mode: "inter-session completion", withUsage: true },
    { mode: "inter-session completion", withUsage: false },
  ])("preserves diagnostics for $mode with usage=$withUsage", async ({ mode, withUsage }) => {
    const fixture = await createFixture();
    fixture.context.isHeartbeat = mode === "heartbeat";
    fixture.context.execution.fallback.exhausted = mode === "exhausted fallback";
    if (mode === "inter-session completion") {
      fixture.context.followupRun.run.inputProvenance = {
        kind: "inter_session",
        sourceTool: "subagent_announce",
      };
    }
    const before = fixture.read()?.contextBudgetStatus;
    await fixture.account(lane, { usage: withUsage ? { input: 120 } : undefined });
    expect(fixture.read()?.contextBudgetStatus).toEqual(before);
  });

  it.each([
    { name: "fresh", contextBudgetStatus: diagnostic },
    { name: "unavailable", contextBudgetStatus: undefined },
  ])(
    "records a $name diagnostic after preflight compaction without usage",
    async ({ contextBudgetStatus }) => {
      const fixture = await createFixture();
      await incrementRunCompactionCount({
        sessionEntry: fixture.context.activeSessionEntry,
        sessionStore: fixture.context.activeSessionStore,
        sessionKey: fixture.context.sessionKey,
        storePath: fixture.context.storePath,
        amount: 1,
        compactionTokensAfter: 40,
      });
      expect(fixture.read()?.contextBudgetStatus).toBeUndefined();
      fixture.context.preflightCompactionApplied = true;
      await fixture.account(lane, { contextBudgetStatus });
      expect(fixture.read()?.contextBudgetStatus).toEqual(contextBudgetStatus);
      expect(fixture.read()).toMatchObject({
        totalTokens: 40,
        totalTokensFresh: true,
        compactionCount: 1,
      });
    },
  );

  it("clears diagnostics when only a post-compaction snapshot remains", async () => {
    const fixture = await createFixture();
    await fixture.account(lane, { usage: { input: 120 }, compactionTokensAfter: 40 });
    expect(fixture.read()?.contextBudgetStatus).toBeUndefined();
    expect(fixture.read()).toMatchObject({ totalTokens: 40, totalTokensFresh: true });
  });

  it.each(["session", "context-pressure-successor"])(
    "accounts current-generation compaction into %s",
    async (sessionId) => {
      const fixture = await createFixture();
      fixture.context.execution.autoCompactionCount = 1;
      await fixture.account(lane, {
        sessionId,
        compactionCount: 1,
        usage: { input: 120 },
        lastCallUsage: { input: 120 },
      });
      expect(fixture.read()?.contextBudgetStatus).toBeUndefined();
      expect(fixture.read()).toMatchObject({
        sessionId,
        lifecycleRevision: "generation-1",
        compactionCount: 1,
        totalTokens: 120,
        totalTokensFresh: true,
        estimatedCostUsd: 0.00012,
      });
    },
  );

  it.each([
    { name: "session", replacement: { sessionId: "replacement-session" } },
    { name: "lifecycle", replacement: { lifecycleRevision: "generation-2" } },
  ])(
    "does not compact replacement $name telemetry after the old owner resumes",
    async ({ replacement }) => {
      const fixture = await createFixture();
      fixture.context.execution.autoCompactionCount = 1;
      const pendingTool = createDeferred();
      fixture.context.pendingToolTasks.add(pendingTool.promise);
      const accounting = fixture.account(lane, {
        compactionCount: 1,
        usage: { input: 120 },
        lastCallUsage: { input: 120 },
      });
      // Simulate an old closure surviving forced terminal-settlement release.
      // Normal competing reset/delete waits for admission; this is the resumed
      // owner's write fence after replacement, not a claim that reset bypasses it.
      const next: SessionEntry = {
        ...fixture.context.activeSessionEntry!,
        ...replacement,
        updatedAt: 30,
        contextBudgetStatus: {
          ...diagnostic,
          updatedAt: 30,
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 100,
          remainingPromptBudgetTokens: 800,
          overflowTokens: 0,
        },
        compactionCount: 9,
        totalTokens: 666,
        totalTokensFresh: true,
        inputTokens: 500,
        outputTokens: 70,
        cacheRead: 50,
        cacheWrite: 5,
        estimatedCostUsd: 7,
      };
      await fixture.replace(next);
      const persisted = fixture.read();
      pendingTool.resolve();
      await accounting;
      expect(fixture.read()).toEqual(persisted);
    },
  );

  it.each([
    { name: "session", replacement: { sessionId: "replacement-session" }, withUsage: true },
    { name: "session", replacement: { sessionId: "replacement-session" }, withUsage: false },
    { name: "generation", replacement: { lifecycleRevision: "generation-2" }, withUsage: true },
    { name: "generation", replacement: { lifecycleRevision: "generation-2" }, withUsage: false },
  ])(
    "does not write an old result into a replacement $name with usage=$withUsage",
    async ({ replacement, withUsage }) => {
      const fixture = await createFixture();
      const next = {
        ...fixture.context.activeSessionEntry!,
        ...replacement,
        contextBudgetStatus: undefined,
      };
      await fixture.replace(next);
      const persisted = fixture.read();
      const usage = withUsage ? { input: 120 } : undefined;
      await fixture.account(lane, { usage, lastCallUsage: usage });
      expect(fixture.read()).toEqual(persisted);
    },
  );

  it("keeps the admitted generation while pending tool work drains", async () => {
    const fixture = await createFixture();
    const pendingTool = createDeferred();
    fixture.context.pendingToolTasks.add(pendingTool.promise);
    const accounting = fixture.account(lane, { usage: { input: 120 } });
    const replacement = {
      ...fixture.context.activeSessionEntry!,
      lifecycleRevision: "generation-2",
      contextBudgetStatus: undefined,
    };
    await fixture.replace(replacement);
    Object.assign(fixture.context.activeSessionEntry!, replacement);
    const persisted = fixture.read();
    pendingTool.resolve();
    await accounting;
    expect(fixture.read()).toEqual(persisted);
  });

  it("does not recreate a deleted session while accounting a completed result", async () => {
    const fixture = await createFixture();
    await applySessionEntryLifecycleMutation({
      storePath: fixture.context.storePath!,
      removals: [{ sessionKey: fixture.context.sessionKey! }],
      skipMaintenance: true,
    });
    await fixture.account(lane, { usage: { input: 120 } });
    expect(fixture.read()).toBeUndefined();
  });
});
