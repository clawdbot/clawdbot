import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentMeta } from "../../agents/embedded-agent-runner/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type {
  AgentTurnCompaction,
  AgentTurnExecutionResult,
} from "./agent-runner-execution.types.js";
import { accountAgentTurn, accountFollowupTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import {
  createReplyOperation,
  retainReplyOperationUntilComplete,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import { incrementCompactionCount } from "./session-updates.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const operations: ReplyOperation[] = [];
let suiteRoot: string;
let storePath: string;
let fixtureSequence = 0;
beforeAll(() => {
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-accounting-suite-"));
  storePath = path.join(suiteRoot, "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  disposeOpenClawAgentDatabaseByPath(storePath);
  expect(isOpenClawAgentDatabaseOpen(storePath)).toBe(false);
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});
afterEach(() => {
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
});
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
  const fixtureId = ++fixtureSequence;
  const sessionKey = `agent:main:accounting-${fixtureId}`;
  const sessionId = `accounting-session-${fixtureId}`;
  const runId = `context-pressure-run-${fixtureId}`;
  const entry: InternalSessionEntry = {
    sessionId,
    lifecycleRevision: "generation-1",
    activeWriterRunId: runId,
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
  const replyOperation = createReplyOperation({
    sessionId: entry.sessionId,
    sessionKey,
    resetTriggered: false,
  });
  replyOperation.setPhase("running");
  retainReplyOperationUntilComplete(replyOperation);
  operations.push(replyOperation);
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
    replyOperation,
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
    runId,
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
  const accountQueued = (outcome: AgentTurnExecutionResult["outcome"]) =>
    accountFollowupTurn({
      turn,
      defaults: {
        defaultModel: diagnostic.model,
        typing: createMockTypingController(),
        typingMode: "never",
        opts: { isHeartbeat: context.isHeartbeat },
      },
      execution: {
        commentaryPayloadsEnabled: false,
        execution: { runId: context.runId, outcome },
        runStartedAt: context.runStartedAt,
        sessionCtx: {},
        pendingToolTasks: context.pendingToolTasks,
        progress: { drain: async () => {} },
      },
    });
  const recordCompaction = (params: { sessionId?: string; currentContextTokens?: number } = {}) => {
    const fact: CompactionAccountingFact = {
      kind: "durable",
      count: 1,
      currentContextSnapshot: { tokens: params.currentContextTokens },
      target: {
        agentId: "main",
        sessionKey,
        storePath,
        sessionId: params.sessionId ?? entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      },
    };
    const compaction: AgentTurnCompaction = { count: fact.count, durable: [fact] };
    context.execution.autoCompactionCount = compaction.count;
    context.execution.compaction = compaction;
    return compaction;
  };
  return {
    sessionId,
    context,
    turn,
    deliverQueued: async () => {
      const registry = createEmptyPluginRegistry();
      registry.providers.push({
        pluginId: "synthetic",
        source: "test",
        provider: { id: diagnostic.provider, label: "Synthetic provider", auth: [] },
      });
      return withPluginRuntimeRegistryScope(registry, async () => {
        const delivered: ReplyPayload[] = [];
        const accounting = await accountQueued(context.execution);
        const decision = resolveFollowupDeliveryDecision({
          turn,
          execution: { runId: context.runId, outcome: context.execution },
          accounting,
          opts: { onBlockReply: async () => {} },
        });
        await deliverFollowupDecision({
          decision,
          turn,
          defaults: {
            defaultModel: diagnostic.model,
            typing: createMockTypingController(),
            typingMode: "never",
            opts: {
              onBlockReply: async (payload) => {
                delivered.push(payload);
              },
            },
          },
          runId: context.runId,
          runFollowup: async () => {},
        });
        return delivered;
      });
    },
    recordCompaction,
    accountAborted: (reason: "user" | "restart") => {
      const compaction =
        context.execution.compaction ?? recordCompaction({ currentContextTokens: 40 });
      if (reason === "restart") {
        replyOperation.abortForRestart();
      } else {
        replyOperation.abortByUser();
      }
      return accountQueued({ kind: "aborted", reason, compaction });
    },
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
        await accountQueued(context.execution);
      }
    },
  };
}

it.each([
  { stored: "off", selected: "raw", authorized: true, trace: true },
  { stored: "raw", selected: "off", authorized: true, trace: false },
  { stored: "raw", selected: undefined, authorized: true, trace: true },
  { stored: "off", selected: "raw", authorized: false, trace: false },
] as const)(
  "delivers queued trace $selected over stored $stored with authority=$authorized",
  async ({ stored, selected, authorized, trace }) => {
    const fixture = await createFixture();
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      traceLevel: stored,
      verboseLevel: "off",
    });
    fixture.context.followupRun.prompt = "QUEUED_INPUT";
    fixture.context.followupRun.run.traceAuthorized = authorized;
    fixture.context.followupRun.run.traceLevelOverride = selected;
    const delivered = await fixture.deliverQueued();
    expect(delivered.some((payload) => payload.text === "done")).toBe(true);
    const diagnostics = delivered.find((payload) =>
      payload.text?.includes("Model Input (User Role)"),
    );
    expect(Boolean(diagnostics)).toBe(trace);
    if (diagnostics) {
      expect(diagnostics.text).toContain("QUEUED_INPUT");
      expect(isReplyPayloadTerminalContent(diagnostics)).toBe(false);
    }
    expect(fixture.read()?.traceLevel).toBe(stored);
  },
);

it.each([
  { stored: "off", selected: "on", status: true },
  { stored: "on", selected: "off", status: false },
] as const)(
  "delivers queued plugin status at turn verbosity $selected over stored $stored",
  async ({ stored, selected, status }) => {
    const fixture = await createFixture();
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      verboseLevel: stored,
      pluginDebugEntries: [{ pluginId: "synthetic", lines: ["PLUGIN_STATUS_MARKER"] }],
    });
    fixture.context.followupRun.run.verboseLevelOverride = selected;
    const delivered = await fixture.deliverQueued();
    expect(delivered.some((payload) => payload.text?.includes("PLUGIN_STATUS_MARKER"))).toBe(
      status,
    );
    expect(fixture.read()?.verboseLevel).toBe(stored);
  },
);

describe.each(["ordinary", "followup"] as const)("%s completion verbosity", (lane) => {
  it.each([
    { initial: "on", live: "off", override: undefined, visible: false },
    { initial: "off", live: "on", override: undefined, visible: true },
    { initial: "on", live: "off", override: "on", visible: true },
    { initial: "off", live: "on", override: "off", visible: false },
  ] as const)(
    "uses live $live after $initial unless the turn selects $override",
    async ({ initial, live, override, visible }) => {
      const fixture = await createFixture();
      const entry = fixture.context.activeSessionEntry!;
      entry.verboseLevel = initial;
      fixture.context.resolvedVerboseLevel = override ?? initial;
      fixture.context.followupRun.run.verboseLevel = override ?? initial;
      fixture.context.followupRun.run.verboseLevelOverride = override;
      fixture.context.followupRun.run.traceAuthorized = false;
      await fixture.replace({
        ...entry,
        verboseLevel: live,
        pluginDebugEntries: [{ pluginId: "synthetic", lines: ["LIVE_VERBOSE_STATUS"] }],
      });
      const result =
        lane === "ordinary"
          ? await finalizeReplyAgentRun(fixture.context)
          : await fixture.deliverQueued();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text).toContain("done");
      expect(text.includes("LIVE_VERBOSE_STATUS")).toBe(visible);
      expect(fixture.read()?.verboseLevel).toBe(live);
    },
  );
});

it.each([
  { lane: "ordinary", field: "sessionId" },
  { lane: "ordinary", field: "lifecycleRevision" },
  { lane: "followup", field: "sessionId" },
  { lane: "followup", field: "lifecycleRevision" },
] as const)(
  "keeps $lane diagnostic refresh inside its captured $field",
  async ({ lane, field }) => {
    const fixture = await createFixture();
    const original = fixture.context.activeSessionEntry!;
    const replacement = {
      ...original,
      [field]: field === "sessionId" ? `${fixture.sessionId}-replacement` : "replacement",
      updatedAt: Date.now(),
      traceLevel: "on" as const,
      pluginDebugEntries: [{ pluginId: "replacement", lines: ["🔎 REPLACEMENT_DIAGNOSTIC"] }],
    };
    fixture.context.followupRun.run.traceAuthorized = true;
    fixture.context.followupRun.run.traceLevelOverride = "on";
    fixture.context.activeSessionStore = fixture.turn.sessionStore;
    const reader = vi
      .spyOn(sessionAccessor, "loadSessionEntryReadOnly")
      .mockReturnValue(replacement);
    try {
      const result =
        lane === "ordinary"
          ? await finalizeReplyAgentRun(fixture.context)
          : await fixture.deliverQueued();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text).not.toContain("REPLACEMENT_DIAGNOSTIC");
    } finally {
      reader.mockRestore();
      expect(fixture.turn.session.current()).toMatchObject({
        sessionId: original.sessionId,
        lifecycleRevision: original.lifecycleRevision,
      });
    }
  },
);

it.each(["NO_REPLY", "hook_block"] as const)(
  "keeps a queued %s completion silent despite trace",
  async (kind) => {
    const fixture = await createFixture();
    fixture.context.followupRun.run.traceAuthorized = true;
    fixture.context.followupRun.run.traceLevelOverride = "raw";
    fixture.context.execution.result.payloads = [];
    if (kind === "NO_REPLY") {
      fixture.context.execution.result.meta.finalAssistantRawText = "NO_REPLY";
    } else {
      fixture.context.execution.result.meta.error = { kind: "hook_block", message: "blocked" };
    }
    expect(await fixture.deliverQueued()).toEqual([]);
  },
);

it("does not let queued diagnostics replace a missing terminal answer", async () => {
  const fixture = await createFixture();
  fixture.context.followupRun.run.traceAuthorized = true;
  fixture.context.followupRun.run.traceLevelOverride = "raw";
  fixture.context.execution.result.payloads = [];
  const delivered = await fixture.deliverQueued();
  expect(
    delivered.some((payload) => payload.isError && isReplyPayloadTerminalContent(payload)),
  ).toBe(true);
  const supplement = delivered.find((payload) => payload.text?.includes("Model Input (User Role)"));
  expect(supplement?.isStatusNotice).toBe(true);
});

it("keeps queued diagnostic supplements behind source send policy", async () => {
  const fixture = await createFixture();
  fixture.context.followupRun.run.traceAuthorized = true;
  fixture.context.followupRun.run.traceLevelOverride = "raw";
  fixture.turn.sendPolicy = "deny";
  expect(await fixture.deliverQueued()).toEqual([]);
});

it("accounts a completed compaction before an empty heartbeat skips reply preparation", async () => {
  const fixture = await createFixture();
  fixture.context.isHeartbeat = true;
  fixture.recordCompaction({ currentContextTokens: 40 });
  fixture.context.execution.result.payloads = [];
  fixture.context.execution.result.meta.agentMeta = {
    sessionId: fixture.sessionId,
    provider: diagnostic.provider,
    model: diagnostic.model,
    compactionCount: 1,
    compactionTokensAfter: 40,
  };

  expect(await finalizeReplyAgentRun(fixture.context)).toBeUndefined();

  expect(fixture.read()).toMatchObject({
    sessionId: fixture.sessionId,
    compactionCount: 1,
    totalTokens: 40,
    totalTokensFresh: true,
  });
  expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
});

it.each(["NO_REPLY", "hook_block", "empty"] as const)(
  "finalizes a %s fallback without confusing deliberate silence with failure",
  async (completion) => {
    const fixture = await createFixture();
    const { context } = fixture;
    const onAgentRunTerminalOutcome = vi.fn();
    context.opts = { onAgentRunTerminalOutcome };
    context.execution.resolved = { provider: "fallback-provider", model: "fallback-model" };
    context.execution.fallback.attempts = [
      { provider: diagnostic.provider, model: diagnostic.model, reason: "auth", error: "No login" },
    ];
    context.execution.result.payloads = [];
    if (completion === "NO_REPLY") {
      context.execution.result.meta.finalAssistantRawText = "NO_REPLY";
    } else if (completion === "hook_block") {
      context.execution.result.meta.error = { kind: "hook_block", message: "Reply suppressed" };
    }

    const result = await finalizeReplyAgentRun(context);
    context.replyOperation.complete();

    if (completion === "empty") {
      expect(result).toMatchObject({
        isError: true,
        text: expect.stringContaining("produced no visible reply"),
      });
      expect(context.replyOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
      expect(onAgentRunTerminalOutcome).toHaveBeenCalledWith("failed");
    } else {
      expect(result).toBeUndefined();
      expect(context.replyOperation.result).toEqual({ kind: "completed" });
      expect(onAgentRunTerminalOutcome).not.toHaveBeenCalledWith("failed");
    }
    expect(fixture.read()?.fallbackNotice).toMatchObject({
      kind: "active",
      activeModel: "fallback-provider/fallback-model",
    });
    expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
  },
);

describe("cancelled followup compaction accounting", () => {
  it.each(["user", "restart"] as const)(
    "retains committed compaction facts after %s abort without success bookkeeping",
    async (reason) => {
      const fixture = await createFixture();
      const original = {
        ...fixture.context.activeSessionEntry!,
        compactionCount: 3,
        groupActivationNeedsSystemIntro: true,
        inputTokens: 120,
        outputTokens: 8,
        cacheRead: 20,
        cacheWrite: 4,
      };
      await fixture.replace(original);
      Object.assign(fixture.context.activeSessionEntry!, original);

      expect(await fixture.accountAborted(reason)).toBeUndefined();

      expect(fixture.read()).toMatchObject({
        sessionId: fixture.sessionId,
        lifecycleRevision: "generation-1",
        compactionCount: 4,
        totalTokens: 40,
        totalTokensFresh: true,
        groupActivationNeedsSystemIntro: true,
        modelProvider: diagnostic.provider,
        model: diagnostic.model,
      });
      // Cancellation preserves committed compaction, not the previous run snapshot.
      for (const entry of [
        fixture.read(),
        fixture.context.activeSessionStore?.[fixture.context.sessionKey!],
      ]) {
        expect(entry?.inputTokens).toBeUndefined();
        expect(entry?.outputTokens).toBeUndefined();
        expect(entry?.cacheRead).toBeUndefined();
        expect(entry?.cacheWrite).toBeUndefined();
        expect(entry?.estimatedCostUsd).toBeUndefined();
      }
      expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
    },
  );

  it("accounts cancellation against the committed successor despite a predecessor cache", async () => {
    const fixture = await createFixture();
    const sessionId = `${fixture.sessionId}-accepted-successor`;
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      sessionId,
      compactionCount: 3,
    });
    fixture.recordCompaction({ sessionId, currentContextTokens: 40 });
    fixture.context.replyOperation.updateSessionId(sessionId);
    expect(fixture.context.activeSessionEntry?.sessionId).toBe(fixture.sessionId);

    await fixture.accountAborted("user");

    expect(fixture.read()).toMatchObject({ sessionId, compactionCount: 4, totalTokens: 40 });
  });

  it("keeps target-less cancelled counts presentation-only", async () => {
    const fixture = await createFixture();
    fixture.context.execution.compaction = { count: 2, durable: [] };
    const before = fixture.read();

    await fixture.accountAborted("user");

    expect(fixture.read()).toEqual(before);
  });

  it("rejects a late old operation even when a replacement reuses its writer string", async () => {
    const fixture = await createFixture();
    fixture.recordCompaction({ currentContextTokens: 40 });
    fixture.context.replyOperation.complete();
    const replacement = createReplyOperation({
      sessionId: fixture.sessionId,
      sessionKey: fixture.context.sessionKey!,
      resetTriggered: false,
    });
    operations.push(replacement);
    const before = fixture.read();

    await fixture.accountAborted("user");

    expect(fixture.read()).toEqual(before);
  });

  it.each([
    { name: "session", replacement: { sessionId: "replacement-session" } },
    { name: "lifecycle", replacement: { lifecycleRevision: "generation-2" } },
    { name: "writer", replacement: { activeWriterRunId: "newer-writer" } },
  ])("does not apply cancelled facts to a replacement $name", async ({ name, replacement }) => {
    const fixture = await createFixture();
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      ...(name === "session" ? { sessionId: `${fixture.sessionId}-replacement` } : replacement),
      compactionCount: 9,
      totalTokens: 666,
    });
    const replacementEntry = fixture.read();

    await fixture.accountAborted("user");

    expect(fixture.read()).toEqual(replacementEntry);
  });
});

describe.each(["ordinary", "followup"] as const)("%s context-pressure accounting", (lane) => {
  it.each([
    { runtimeOwned: true, finalizer: false },
    { runtimeOwned: true, finalizer: true },
    { runtimeOwned: false, finalizer: false },
  ])(
    "records runtime-selected models without inventing host fallback (owned: $runtimeOwned, finalizer: $finalizer)",
    async ({ runtimeOwned, finalizer }) => {
      const fixture = await createFixture();
      const outer = { provider: "outer-provider", model: "outer-model" };
      const selection = {
        provider: diagnostic.provider,
        model: finalizer ? "native-selected-model" : diagnostic.model,
      };
      const models = fixture.context.cfg.models!.providers!.openai!.models;
      models.push({
        ...models[0]!,
        id: "native-selected-model",
        cost: { input: 10, output: 20, cacheRead: 5, cacheWrite: 10 },
      });
      Object.assign(fixture.context.followupRun.run, outer);
      const entry = fixture.context.activeSessionEntry!;
      Object.assign(entry, { modelProvider: outer.provider, model: outer.model });
      await fixture.replace(entry);

      await fixture.account(lane, {
        provider: diagnostic.provider,
        model: diagnostic.model,
        agentHarnessId: "codex",
        ...(runtimeOwned ? { runtimeModelSelection: selection } : {}),
        usage: { input: 120, output: 8 },
      });

      const persisted = fixture.read();
      expect(persisted?.fallbackNotice === undefined).toBe(runtimeOwned);
      expect(persisted).toMatchObject({
        modelProvider: runtimeOwned ? selection.provider : outer.provider,
        model: runtimeOwned ? selection.model : outer.model,
        inputTokens: 120,
        outputTokens: 8,
        estimatedCostUsd: 0.000136,
      });
      if (runtimeOwned) {
        expect(persisted?.agentHarnessId).toBe("codex");
      }
    },
  );

  it("does not infer a durable target from publisher compaction metadata", async () => {
    const fixture = await createFixture();
    fixture.context.execution.autoCompactionCount = 2;
    fixture.context.execution.compaction = { count: 2, durable: [] };

    await fixture.account(lane, {
      sessionId: `${fixture.sessionId}-unverified-successor`,
      compactionCount: 2,
      compactionTokensAfter: 40,
      usage: { input: 120, output: 8 },
      lastCallUsage: { input: 120, output: 8 },
      promptTokens: 120,
    });

    expect(fixture.read()?.sessionId).toBe(fixture.sessionId);
    expect(fixture.read()?.compactionCount).toBeUndefined();
    expect(fixture.read()?.totalTokens).toBeUndefined();
    expect(fixture.read()).toMatchObject({
      totalTokensFresh: false,
      inputTokens: 120,
      outputTokens: 8,
    });
  });

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
      await incrementCompactionCount({
        sessionEntry: fixture.context.activeSessionEntry,
        sessionStore: fixture.context.activeSessionStore,
        sessionKey: fixture.context.sessionKey,
        storePath: fixture.context.storePath,
        amount: 1,
        tokensAfter: 40,
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

  it.each([
    { order: "compaction then model", currentContextTokens: 120, withModelSnapshot: true },
    { order: "model then compaction", currentContextTokens: 40, withModelSnapshot: true },
    { order: "model then zero compaction", currentContextTokens: 0, withModelSnapshot: true },
    {
      order: "later unknown observation",
      currentContextTokens: undefined,
      withModelSnapshot: true,
    },
    {
      order: "compaction without model context",
      currentContextTokens: 40,
      withModelSnapshot: false,
    },
  ])(
    "uses $order chronology without discarding billing usage",
    async ({ currentContextTokens, withModelSnapshot }) => {
      const fixture = await createFixture();
      fixture.recordCompaction({ currentContextTokens });
      const usage = { input: 120, output: 8 };
      await fixture.account(lane, {
        usage,
        lastCallUsage: withModelSnapshot ? usage : undefined,
        promptTokens: withModelSnapshot ? 120 : undefined,
        compactionTokensAfter: 40,
      });
      const persisted = fixture.read();
      expect(persisted?.contextBudgetStatus).toBeUndefined();
      expect(persisted?.totalTokens).toBe(currentContextTokens);
      expect(persisted).toMatchObject({
        compactionCount: 1,
        totalTokensFresh: currentContextTokens !== undefined,
        inputTokens: 120,
        outputTokens: 8,
        estimatedCostUsd: 0.000136,
      });
      expect(fixture.context.activeSessionStore?.[fixture.context.sessionKey!]).toMatchObject({
        inputTokens: 120,
        outputTokens: 8,
        totalTokensFresh: currentContextTokens !== undefined,
      });
    },
  );

  it.each(["session", "context-pressure-successor"])(
    "accounts current-generation compaction into accepted %s",
    async (target) => {
      const fixture = await createFixture();
      const sessionId =
        target === "session"
          ? fixture.sessionId
          : `${fixture.sessionId}-context-pressure-successor`;
      fixture.recordCompaction({ sessionId, currentContextTokens: 120 });
      await fixture.replace({ ...fixture.context.activeSessionEntry!, sessionId });
      fixture.context.replyOperation.updateSessionId(sessionId);
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
    { name: "writer", replacement: { activeWriterRunId: "newer-writer" } },
  ])(
    "does not compact replacement $name telemetry after the old owner resumes",
    async ({ name, replacement }) => {
      const fixture = await createFixture();
      fixture.recordCompaction();
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
        ...(name === "session" ? { sessionId: `${fixture.sessionId}-replacement` } : replacement),
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
    async ({ name, replacement, withUsage }) => {
      const fixture = await createFixture();
      const next = {
        ...fixture.context.activeSessionEntry!,
        ...(name === "session" ? { sessionId: `${fixture.sessionId}-replacement` } : replacement),
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
