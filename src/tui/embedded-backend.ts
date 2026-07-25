// Implements the embedded backend used by local TUI sessions.
import { randomUUID } from "node:crypto";
import type { SessionsPatchResult } from "../../packages/gateway-protocol/src/index.js";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
import { ensureContextWindowCacheLoaded } from "../agents/context.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "../agents/embedded-agent-runner/runs.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { ensureRuntimePluginsLoaded } from "../agents/runtime-plugins.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { resolveTextCommand } from "../auto-reply/commands-registry.js";
import { parseGoalCommand } from "../auto-reply/reply/commands-goal.js";
import { resolveQueueSettings } from "../auto-reply/reply/queue/settings.js";
import {
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_DEBOUNCE_MS,
  DEFAULT_QUEUE_DROP,
} from "../auto-reply/reply/queue/state.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import { createDefaultDeps } from "../cli/deps.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  getSessionGoal,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "../config/sessions.js";
import { applySessionPatchProjection } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isChatStopCommandText } from "../gateway/chat-abort.js";
import {
  projectRecentChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "../gateway/chat-display-projection.js";
import { augmentChatHistoryWithCliSessionImports } from "../gateway/cli-session-history.js";
import {
  normalizeLiveAssistantBufferedText,
  projectLiveAssistantBufferedText,
  resolveAssistantLiveChatInput,
  resolveMergedAssistantText,
  shouldSuppressAssistantEventForLiveChat,
} from "../gateway/live-chat-projector.js";
import { getMaxChatHistoryMessagesBytes } from "../gateway/server-constants.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
} from "../gateway/server-methods/chat.js";
import { loadGatewayModelCatalog } from "../gateway/server-model-catalog.js";
import { createGatewaySession } from "../gateway/session-create-service.js";
import { performGatewaySessionReset } from "../gateway/session-reset-service.js";
import {
  capArrayByJsonBytes,
  readSessionMessagesAsync,
} from "../gateway/session-transcript-readers.js";
import {
  buildGatewaySessionInfo,
  getSessionDefaults,
  listAgentsForGateway,
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  loadSessionEntryReadOnly,
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "../gateway/session-utils.js";
import { projectSessionsPatchEntry } from "../gateway/sessions-patch.js";
import { type AgentEventPayload, onAgentEvent } from "../infra/agent-events.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  clearEmbeddedPluginApprovalBroker,
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import { logInfo, logWarn } from "../logger.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  applyQueueDropPolicy,
  buildCollectPrompt,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../utils/queue-helpers.js";
import { resolveLocalRunShutdownGraceMs } from "./local-run-shutdown.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiApprovalDecision,
  TuiBackend,
  TuiChatSendResult,
  TuiEvent,
  TuiModelChoice,
  TuiSessionList,
  TuiSessionCreateOptions,
} from "./tui-backend.js";

type LocalRunState = {
  sessionKey: string;
  agentId?: string;
  controller: AbortController;
  buffer: string;
  lastBroadcastText?: string;
  isBtw: boolean;
  question?: string;
  finishing: boolean;
  lifecycleEnded: boolean;
  lifecycleStopReason?: string;
  toolErrorSummary?: string;
  finalSent: boolean;
  registered: boolean;
  pendingQueue?: {
    mode: "followup" | "collect";
    messages: string[];
    debounceMs: number;
    lastEnqueuedAt: number;
    dropPolicy: NonNullable<QueueSettings["dropPolicy"]>;
    droppedCount: number;
    summaryLines: string[];
  };
  queuedRunReady: Promise<void>;
  markQueuedRunReady: () => void;
};

type QueuedSessionRun = {
  runId: string;
  run: LocalRunState;
  promise: Promise<void>;
};

type LocalPendingMessage = {
  run: LocalRunState;
  messageIndex: number;
  message: string;
};

const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;

const silentRuntime = {
  log: (..._args: unknown[]) => undefined,
  error: (..._args: unknown[]) => undefined,
  exit: (code: number): never => {
    throw new Error(`embedded tui runtime exit ${String(code)}`);
  },
};

const embeddedSessionStartupMigrationLog = {
  info: (message: string) => logInfo(message, silentRuntime),
  warn: (message: string) => logWarn(message, silentRuntime),
};

function hasProviderWildcardModelAllowlist(cfg: OpenClawConfig) {
  const modelMaps = [
    cfg.agents?.defaults?.models,
    ...listAgentEntries(cfg).map((agent) => agent.models),
  ];
  return modelMaps.some((models) =>
    Object.keys(models ?? {}).some((key) => key.trim().endsWith("/*")),
  );
}

function resolveConfiguredReplaceModeCatalog(cfg: OpenClawConfig) {
  if (cfg.models?.mode !== "replace") {
    return undefined;
  }
  if (hasProviderWildcardModelAllowlist(cfg)) {
    return undefined;
  }
  return buildConfiguredModelCatalog({ cfg });
}

function shouldLoadFullGatewayCatalogForReplaceMode(cfg: OpenClawConfig) {
  return cfg.models?.mode === "replace" && hasProviderWildcardModelAllowlist(cfg);
}

function ensureEmbeddedHistoryRuntimePluginsLoaded(params: {
  cfg: OpenClawConfig;
  sessionAgentId: string;
}): { status: "warmed" } | { status: "failed"; error: string } {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.sessionAgentId);
    ensureRuntimePluginsLoaded({
      config: params.cfg,
      workspaceDir,
    });
    return { status: "warmed" };
  } catch (err) {
    return { status: "failed", error: String(err) };
  }
}

async function loadEmbeddedTuiModelCatalog(cfg: OpenClawConfig) {
  const configuredCatalog = resolveConfiguredReplaceModeCatalog(cfg);
  if (configuredCatalog !== undefined) {
    return configuredCatalog;
  }
  return await loadGatewayModelCatalog(
    shouldLoadFullGatewayCatalogForReplaceMode(cfg) ? { readOnly: false } : undefined,
  );
}

function resolveBtwQuestion(message: string): string | undefined {
  const match = /^\/(?:btw|side)(?::|\s)+(.*)$/i.exec(message.trim());
  const question = match?.[1]?.trim();
  return question ? question : undefined;
}

function buildLocalQueuedPrompt(queue: NonNullable<LocalRunState["pendingQueue"]>): string {
  const summary = previewQueueSummaryPrompt({
    state: queue,
    noun: "message",
  });
  const prompt =
    queue.mode === "collect" && queue.messages.length > 1
      ? buildCollectPrompt({
          title: "[Queued messages while agent was busy]",
          items: queue.messages,
          renderItem: (message, index) => `---\nQueued #${index + 1}\n${message}`,
        })
      : (queue.messages[0] ?? "");
  return [summary, prompt].filter(Boolean).join("\n\n");
}

function payloadText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const payload = part as { text?: unknown };
      return typeof payload.text === "string" ? payload.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function timeoutSecondsFromMs(timeoutMs?: number): string | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return undefined;
  }
  return String(Math.max(0, Math.ceil(timeoutMs / 1000)));
}

function resolveDeltaPayload(text: string, previousText: string | undefined) {
  if (previousText === undefined) {
    return { deltaText: text };
  }
  if (!text.startsWith(previousText)) {
    return { deltaText: text, replace: true as const };
  }
  return { deltaText: text.slice(previousText.length) };
}

function createQueuedRunReadiness() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  if (!resolve) {
    throw new Error("Expected queue readiness resolver to be initialized");
  }
  const resolveReady = resolve;
  let settled = false;
  return {
    promise,
    markReady: () => {
      if (settled) {
        return;
      }
      settled = true;
      resolveReady();
    },
  };
}

async function waitForLocalRunShutdown(promises: Promise<void>[]): Promise<boolean> {
  if (promises.length === 0) {
    return true;
  }
  const timeoutMs = resolveLocalRunShutdownGraceMs();
  if (timeoutMs <= 0) {
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  await Promise.race([
    Promise.allSettled(promises).then(() => {
      completed = true;
    }),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return completed;
}

async function waitForQueuedLocalRun(previousRun: QueuedSessionRun, runId: string): Promise<void> {
  await previousRun.run.queuedRunReady;
  if (!previousRun.run.finishing && !previousRun.run.lifecycleEnded) {
    await previousRun.promise;
    return;
  }
  const timeoutMs = resolveLocalRunShutdownGraceMs();
  if (timeoutMs <= 0) {
    throw new Error(
      `timed out waiting for previous local run to finish post-turn maintenance for ${runId}`,
    );
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previousRun.promise,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for previous local run to finish post-turn maintenance for ${runId}`,
            ),
          );
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class EmbeddedTuiBackend implements TuiBackend {
  readonly connection = { url: "local embedded" };

  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  private readonly deps = createDefaultDeps();
  private readonly runs = new Map<string, LocalRunState>();
  private readonly runPromises = new Map<string, Promise<void>>();
  private unsubscribe?: () => void;
  private previousRuntimeLog?: typeof defaultRuntime.log;
  private previousRuntimeError?: typeof defaultRuntime.error;
  private seq = 0;
  private readonly pendingLifecycleErrors = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pluginApprovalBroker = new EmbeddedPluginApprovalBroker();
  private unsubscribePluginApprovals?: () => void;
  // Resolves once the one-time session-key migration has run; store methods await it.
  private ready: Promise<void> = Promise.resolve();

  start() {
    if (this.unsubscribe) {
      return;
    }
    setEmbeddedMode(true);
    void ensureContextWindowCacheLoaded();
    // Suppress console output from logError/logInfo that would pollute the TUI.
    // File logger (getLogger()) still captures everything via logger.ts:35.
    this.previousRuntimeLog = defaultRuntime.log;
    this.previousRuntimeError = defaultRuntime.error;
    defaultRuntime.log = silentRuntime.log;
    defaultRuntime.error = silentRuntime.error;
    // Keep this synchronous so the shared event bus can isolate listener failures.
    this.unsubscribe = onAgentEvent((evt) => this.handleAgentEvent(evt));
    setEmbeddedPluginApprovalBroker(this.pluginApprovalBroker);
    this.unsubscribePluginApprovals = this.pluginApprovalBroker.subscribe((event) => {
      this.emit(event.event, event.payload);
    });
    // Local mode never runs gateway startup; canonicalize orphaned keys once here.
    this.ready = (async () => {
      const { runSessionStartupMigration } =
        await import("../config/sessions/startup-migration.js");
      await runSessionStartupMigration({
        cfg: getRuntimeConfig(),
        env: process.env,
        log: embeddedSessionStartupMigrationLog,
      });
    })();
    queueMicrotask(() => {
      this.onConnected?.();
    });
  }

  async stop() {
    clearEmbeddedPluginApprovalBroker(this.pluginApprovalBroker);
    this.unsubscribePluginApprovals?.();
    this.unsubscribePluginApprovals = undefined;
    const maintenancePromises: Promise<void>[] = [];
    for (const [runId, run] of this.runs) {
      if (run.finishing || run.lifecycleEnded) {
        const promise = this.runPromises.get(runId);
        if (promise) {
          maintenancePromises.push(promise);
        }
        continue;
      }
      run.controller.abort();
    }
    this.pluginApprovalBroker.stop();
    const maintenanceCompleted = await waitForLocalRunShutdown(maintenancePromises);
    if (!maintenanceCompleted) {
      for (const run of this.runs.values()) {
        if (run.finishing || run.lifecycleEnded) {
          run.controller.abort();
        }
      }
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearPendingLifecycleErrors();
    for (const run of this.runs.values()) {
      run.controller.abort();
    }
    this.runs.clear();
    this.runPromises.clear();
    defaultRuntime.log = this.previousRuntimeLog ?? defaultRuntime.log;
    defaultRuntime.error = this.previousRuntimeError ?? defaultRuntime.error;
    this.previousRuntimeLog = undefined;
    this.previousRuntimeError = undefined;
    setEmbeddedMode(false);
  }

  async sendChat(opts: ChatSendOptions): Promise<TuiChatSendResult> {
    await this.ready;
    const runId = opts.runId ?? randomUUID();
    const question = resolveBtwQuestion(opts.message);
    const isQueueCommand = resolveTextCommand(opts.message)?.command.key === "queue";
    const runScope = {
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
    };
    const abortableSessionRun = this.hasAbortableSessionRun(runScope);
    const stopCommand = abortableSessionRun && isChatStopCommandText(opts.message);
    const queuedAfter =
      question || stopCommand || isQueueCommand
        ? undefined
        : this.findQueuedSessionRunPromise(runScope);
    if (stopCommand) {
      this.abortSessionRuns(runScope);
      return { runId };
    }
    let pendingQueue: LocalRunState["pendingQueue"];
    if (queuedAfter) {
      const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
      const { cfg, canonicalKey, entry } = loadSessionEntry(opts.sessionKey, loadOptions);
      let queueSettings = resolveQueueSettings({
        cfg,
        channel: INTERNAL_MESSAGE_CHANNEL,
        sessionEntry: entry,
      });
      if (queueSettings.mode === "steer") {
        const activeSessionId = resolveActiveEmbeddedRunSessionId(canonicalKey);
        if (activeSessionId) {
          const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
            activeSessionId,
            opts.message,
            {
              steeringMode: "all",
              debounceMs: queueSettings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS,
            },
          ).catch(() => undefined);
          if (outcome?.queued) {
            return { runId: queuedAfter.runId };
          }
        }
        queueSettings = { ...queueSettings, mode: "followup" };
      }
      if (queueSettings.mode === "interrupt") {
        this.abortSessionRuns(runScope);
      } else {
        const queued = this.enqueuePendingLocalMessage({
          runScope,
          message: opts.message,
          settings: queueSettings,
          fallbackRunId: queuedAfter.runId,
        });
        if (queued.kind === "handled") {
          return { runId: queued.runId };
        }
        pendingQueue = queued.queue;
      }
    }
    const controller = new AbortController();
    const queuedRunReadiness = createQueuedRunReadiness();
    this.runs.set(runId, {
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      controller,
      buffer: "",
      isBtw: Boolean(question),
      question,
      finishing: false,
      lifecycleEnded: false,
      finalSent: false,
      registered: false,
      ...(pendingQueue ? { pendingQueue } : {}),
      queuedRunReady: queuedRunReadiness.promise,
      markQueuedRunReady: queuedRunReadiness.markReady,
    });

    const runPromise = this.runTurn({
      runId,
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      message: opts.message,
      thinking: opts.thinking,
      deliver: opts.deliver,
      timeoutMs: opts.timeoutMs,
      controller,
      queuedAfter,
    });
    this.runPromises.set(runId, runPromise);
    void runPromise.finally(() => {
      this.runPromises.delete(runId);
    });

    if (isQueueCommand) {
      // Queue directives are control-plane mutations. Complete them before
      // admitting another local prompt so later sends cannot overtake the new mode.
      await runPromise;
    }

    return { runId };
  }

  async abortChat(opts: { sessionKey: string; agentId?: string; runId?: string }) {
    if (!opts.runId) {
      // Session-scoped abort for local embedded: abort all matching runs.
      let aborted = false;
      const runIds: string[] = [];
      for (const [runId, run] of this.runs) {
        if (run.isBtw) {
          continue;
        }
        if (run.sessionKey !== opts.sessionKey) {
          continue;
        }
        if (opts.sessionKey === "global") {
          const defaultAgentId = resolveDefaultAgentId(getRuntimeConfig());
          const requestedAgentId = opts.agentId ? normalizeAgentId(opts.agentId) : defaultAgentId;
          const runAgentId = run.agentId ? normalizeAgentId(run.agentId) : defaultAgentId;
          if (runAgentId !== requestedAgentId) {
            continue;
          }
        }
        if (!this.isAbortableRun(runId, run)) {
          continue;
        }
        run.controller.abort();
        aborted = true;
        runIds.push(runId);
      }
      return { ok: true, aborted, runIds };
    }
    const run = this.runs.get(opts.runId);
    if (!run || run.sessionKey !== opts.sessionKey) {
      return { ok: true, aborted: false, runIds: [] };
    }
    if (opts.sessionKey === "global") {
      const defaultAgentId = resolveDefaultAgentId(getRuntimeConfig());
      const requestedAgentId = opts.agentId ? normalizeAgentId(opts.agentId) : defaultAgentId;
      const runAgentId = run.agentId ? normalizeAgentId(run.agentId) : defaultAgentId;
      if (runAgentId !== requestedAgentId) {
        return { ok: true, aborted: false, runIds: [] };
      }
    }
    if (!this.isAbortableRun(opts.runId, run)) {
      return { ok: true, aborted: false, runIds: [] };
    }
    run.controller.abort();
    return { ok: true, aborted: true, runIds: [opts.runId] };
  }

  async loadHistory(opts: { sessionKey: string; agentId?: string; limit?: number }) {
    await this.ready;
    const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
    const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntryReadOnly(
      opts.sessionKey,
      loadOptions,
    );
    const sessionId = entry?.sessionId;
    const sessionAgentId = resolveSessionAgentId({
      sessionKey: opts.sessionKey,
      config: cfg,
      agentId: opts.agentId,
    });
    const runtimePluginsPrewarm = ensureEmbeddedHistoryRuntimePluginsLoaded({
      cfg,
      sessionAgentId,
    });
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const max = Math.min(1000, typeof opts.limit === "number" ? opts.limit : 200);
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    const localMessages =
      sessionId && storePath
        ? await readSessionMessagesAsync(
            {
              agentId: sessionAgentId,
              sessionEntry: entry,
              sessionId,
              sessionKey: canonicalKey,
              storePath,
            },
            {
              mode: "recent",
              maxMessages: max,
              maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
              allowResetArchiveFallback: true,
            },
          )
        : [];
    const rawMessages = augmentChatHistoryWithCliSessionImports({
      entry,
      provider: resolvedSessionModel.provider,
      localMessages,
    });
    const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg);
    const normalized = augmentChatHistoryWithCanvasBlocks(
      projectRecentChatDisplayMessages(rawMessages, {
        maxChars: effectiveMaxChars,
        maxMessages: max,
      }),
    );
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = replaceOversizedChatHistoryMessages({
      messages: normalized,
      maxSingleMessageBytes: perMessageHardCap,
    });
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    const messages = bounded.messages;

    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const catalog = await loadEmbeddedTuiModelCatalog(cfg);
      thinkingLevel = resolveThinkingDefault({
        cfg,
        provider: resolvedSessionModel.provider,
        model: resolvedSessionModel.model,
        catalog,
      });
    }

    const defaults = getSessionDefaults(cfg, undefined, { allowPluginNormalization: false });
    const sessionInfo = buildGatewaySessionInfo({
      cfg,
      storePath,
      store,
      key: canonicalKey,
      entry,
      agentId: opts.agentId,
    });
    sessionInfo.thinkingLevel = thinkingLevel;
    sessionInfo.verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;

    return {
      sessionKey: opts.sessionKey,
      sessionId,
      messages,
      defaults,
      sessionInfo,
      thinkingLevel,
      fastMode: entry?.fastMode,
      verboseLevel: sessionInfo.verboseLevel,
      runtimePluginsPrewarm,
    };
  }

  async listSessions(opts?: Parameters<TuiBackend["listSessions"]>[0]): Promise<TuiSessionList> {
    await this.ready;
    const cfg = getRuntimeConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, {
      agentId: opts?.agentId,
    });
    return (await listSessionsFromStoreAsync({
      cfg,
      storePath,
      store,
      opts: opts ?? {},
    })) as TuiSessionList;
  }

  async listAgents(): Promise<TuiAgentsList> {
    return listAgentsForGateway(getRuntimeConfig()) as TuiAgentsList;
  }

  async patchSession(
    opts: Parameters<TuiBackend["patchSession"]>[0],
  ): Promise<SessionsPatchResult> {
    await this.ready;
    const cfg = getRuntimeConfig();
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key: opts.key,
      agentId: opts.agentId,
    });
    const applied = await applySessionPatchProjection({
      storePath: target.storePath,
      resolveTarget: ({ entries }) => {
        const store = Object.fromEntries(
          entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
        );
        const { target: migratedTarget, primaryKey } = migrateAndPruneGatewaySessionStoreKey({
          cfg,
          key: opts.key,
          store,
          agentId: opts.agentId,
        });
        return { primaryKey, candidateKeys: migratedTarget.storeKeys };
      },
      project: async ({ primaryKey, existingEntry, entries }) =>
        await projectSessionsPatchEntry({
          cfg,
          entries,
          existingEntry,
          storeKey: primaryKey,
          agentId: opts.agentId,
          patch: opts,
          loadGatewayModelCatalog: () => loadEmbeddedTuiModelCatalog(cfg),
        }),
    });
    if (!applied.ok) {
      throw new Error(applied.error.message);
    }

    const agentId = resolveSessionAgentId({
      sessionKey: target.canonicalKey ?? opts.key,
      config: cfg,
      agentId: opts.agentId,
    });
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    return {
      ok: true as const,
      path: target.storePath,
      key: target.canonicalKey ?? opts.key,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
  }

  async resetSession(key: string, reason?: "new" | "reset", opts?: { agentId?: string }) {
    await this.ready;
    if (loadSessionEntryReadOnly(key, opts).entry?.incognito === true) {
      throw new Error("Incognito sessions cannot reset in place.");
    }
    const result = await performGatewaySessionReset({
      key,
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      reason: reason === "new" ? "new" : "reset",
      commandSource: "tui:embedded",
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    if ("incognitoDeleted" in result) {
      return { ok: true as const, key: result.key, deleted: true as const };
    }
    return { ok: true as const, key: result.key, entry: result.entry, resolved: result.resolved };
  }

  async createSession(opts: TuiSessionCreateOptions) {
    await this.ready;
    const cfg = getRuntimeConfig();
    const result = await createGatewaySession({
      cfg,
      ...opts,
      creation: { via: "operator", actor: { type: "human" } },
      emitCommandHooks: Boolean(opts.parentSessionKey),
      commandSource: "tui:embedded",
      loadGatewayModelCatalog: () => loadEmbeddedTuiModelCatalog(cfg),
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return {
      ok: true as const,
      key: result.key,
      entry: result.entry,
      resolved: result.resolved,
    };
  }

  private async runBtwTurn(params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    question: string;
    timeoutMs?: number;
    controller: AbortController;
  }) {
    const loadOptions = params.agentId ? { agentId: params.agentId } : undefined;
    const { cfg, canonicalKey, storePath, store, entry } = loadSessionEntry(
      params.sessionKey,
      loadOptions,
    );
    if (!entry?.sessionId) {
      throw new Error("/btw requires an active session with existing context.");
    }
    const sessionAgentId = resolveSessionAgentId({
      sessionKey: canonicalKey,
      config: cfg,
      agentId: params.agentId,
    });
    const resolvedModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const timeoutSeconds = timeoutSecondsFromMs(params.timeoutMs);
    const { runBtwSideQuestion } = await import("../agents/btw.js");
    const reply = await runBtwSideQuestion({
      cfg,
      agentDir: resolveAgentDir(cfg, sessionAgentId),
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      question: params.question,
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: canonicalKey,
      storePath,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      opts: {
        runId: params.runId,
        abortSignal: params.controller.signal,
        ...(timeoutSeconds !== undefined ? { timeoutOverrideSeconds: Number(timeoutSeconds) } : {}),
      },
      isNewSession: false,
      messageChannel: INTERNAL_MESSAGE_CHANNEL,
      messageProvider: INTERNAL_MESSAGE_CHANNEL,
      currentChannelId: INTERNAL_MESSAGE_CHANNEL,
    });
    const text = reply?.text?.trim() ?? "";
    if (!text) {
      throw new Error("/btw produced no answer.");
    }
    return {
      sessionKey: canonicalKey,
      text,
      isError: reply?.isError === true,
    };
  }

  async getGatewayStatus() {
    return `local embedded mode${this.runs.size > 0 ? ` (${String(this.runs.size)} active run${this.runs.size === 1 ? "" : "s"})` : ""}`;
  }

  async listPluginApprovals(): Promise<unknown> {
    return this.pluginApprovalBroker.listPending();
  }

  async resolvePluginApproval(id: string, decision: TuiApprovalDecision) {
    return { ok: this.pluginApprovalBroker.resolve(id, decision) };
  }

  async listModels(): Promise<TuiModelChoice[]> {
    const cfg = getRuntimeConfig();
    const catalog = await loadEmbeddedTuiModelCatalog(cfg);
    const { allowedCatalog } = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const entries = allowedCatalog.length > 0 ? allowedCatalog : catalog;
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      provider: entry.provider,
      contextWindow: entry.contextWindow,
      reasoning: entry.reasoning,
    }));
  }

  async runGoalCommand(opts: Parameters<NonNullable<TuiBackend["runGoalCommand"]>>[0]) {
    await this.ready;
    const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
    const { canonicalKey, storePath, entry } = loadSessionEntry(opts.sessionKey, loadOptions);
    const sessionKey = canonicalKey ?? opts.sessionKey;
    const parsed = parseGoalCommand(opts.command.trim());
    if (!parsed) {
      throw new Error("invalid goal command");
    }

    switch (parsed.action) {
      case "status": {
        const snapshot = await getSessionGoal({ sessionKey, storePath });
        return { text: formatSessionGoalStatus(snapshot.goal) };
      }
      case "start":
      case "set":
      case "create": {
        const objective = parsed.text.trim();
        if (!objective) {
          return { text: "Usage: /goal start <objective>" };
        }
        const fallbackEntry = entry ?? { sessionId: randomUUID(), updatedAt: Date.now() };
        const goal = await createSessionGoal({
          sessionKey,
          storePath,
          objective,
          fallbackEntry,
          actor: { type: "human" },
          agentId: opts.agentId,
        });
        return { text: `Goal started: ${goal.objective}` };
      }
      case "edit": {
        const objective = parsed.text.trim();
        if (!objective) {
          return { text: "Usage: /goal edit <objective>" };
        }
        const goal = await updateSessionGoalObjective({
          sessionKey,
          storePath,
          objective,
          actor: { type: "human" },
          agentId: opts.agentId,
        });
        return { text: `Goal updated: ${goal.objective}` };
      }
      case "pause": {
        const goal = await updateSessionGoalStatus({
          sessionKey,
          storePath,
          status: "paused",
          actor: { type: "human" },
          agentId: opts.agentId,
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        return { text: `Goal paused: ${goal.objective}` };
      }
      case "resume": {
        const goal = await updateSessionGoalStatus({
          sessionKey,
          storePath,
          status: "active",
          actor: { type: "human" },
          agentId: opts.agentId,
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        return { text: `Goal resumed: ${goal.objective}` };
      }
      case "complete":
      case "done": {
        const goal = await updateSessionGoalStatus({
          sessionKey,
          storePath,
          status: "complete",
          actor: { type: "human" },
          agentId: opts.agentId,
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        return { text: `Goal complete: ${goal.objective}\nTokens used: ${goal.tokensUsed}` };
      }
      case "block":
      case "blocked": {
        const goal = await updateSessionGoalStatus({
          sessionKey,
          storePath,
          status: "blocked",
          actor: { type: "human" },
          agentId: opts.agentId,
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        return { text: `Goal blocked: ${goal.objective}` };
      }
      case "clear": {
        const removed = await clearSessionGoal({
          sessionKey,
          storePath,
          actor: { type: "human" },
          agentId: opts.agentId,
        });
        return { text: removed ? "Goal cleared." : "No goal to clear." };
      }
      default:
        return {
          text: "Usage: /goal [status] | /goal start <objective> | /goal edit <objective> | /goal pause|resume|complete|block|clear",
        };
    }
  }

  private enqueuePendingLocalMessage(params: {
    runScope: { sessionKey: string; agentId?: string };
    message: string;
    settings: QueueSettings;
    fallbackRunId: string;
  }):
    | { kind: "handled"; runId: string }
    | { kind: "enqueue"; queue: NonNullable<LocalRunState["pendingQueue"]> } {
    const pendingMessages = this.listPendingLocalMessages(params.runScope);
    const overflowQueue = {
      items: [...pendingMessages],
      cap: params.settings.cap ?? DEFAULT_QUEUE_CAP,
      dropPolicy: params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
      droppedCount: 0,
      summaryLines: [] as string[],
    };
    const admitted = applyQueueDropPolicy({
      queue: overflowQueue,
      summarize: (item) => item.message,
    });
    if (!admitted) {
      return { kind: "handled", runId: params.fallbackRunId };
    }

    const retained = new Set(overflowQueue.items);
    const droppedByRun = new Map<LocalRunState, number[]>();
    for (const dropped of pendingMessages) {
      if (retained.has(dropped)) {
        continue;
      }
      const indices = droppedByRun.get(dropped.run) ?? [];
      indices.push(dropped.messageIndex);
      droppedByRun.set(dropped.run, indices);
    }
    const inheritedSummaryLines: string[] = [];
    for (const [run, indices] of droppedByRun) {
      for (const index of indices.toSorted((a, b) => b - a)) {
        run.pendingQueue?.messages.splice(index, 1);
      }
      if (run.pendingQueue?.messages.length === 0) {
        inheritedSummaryLines.push(...run.pendingQueue.summaryLines);
        overflowQueue.droppedCount += run.pendingQueue.droppedCount;
        run.controller.abort();
      }
    }
    overflowQueue.summaryLines.unshift(...inheritedSummaryLines);
    if (overflowQueue.summaryLines.length > overflowQueue.cap) {
      overflowQueue.summaryLines.splice(0, overflowQueue.summaryLines.length - overflowQueue.cap);
    }

    const enqueuedAt = Date.now();
    for (const run of this.runs.values()) {
      if (!this.isSameRunScope(run, params.runScope) || !run.pendingQueue) {
        continue;
      }
      run.pendingQueue.lastEnqueuedAt = enqueuedAt;
      run.pendingQueue.debounceMs = params.settings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS;
    }

    if (params.settings.mode === "collect") {
      const target = [...this.runs.entries()].findLast(
        ([, run]) => this.isSameRunScope(run, params.runScope) && run.pendingQueue,
      );
      const targetQueue = target?.[1].pendingQueue;
      if (target && targetQueue?.mode === "collect" && !target[1].controller.signal.aborted) {
        const [targetRunId] = target;
        targetQueue.messages.push(params.message);
        targetQueue.dropPolicy = params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP;
        targetQueue.droppedCount += overflowQueue.droppedCount;
        targetQueue.summaryLines.push(...overflowQueue.summaryLines);
        return { kind: "handled", runId: targetRunId };
      }
    }

    return {
      kind: "enqueue",
      queue: {
        mode: params.settings.mode === "collect" ? "collect" : "followup",
        messages: [params.message],
        debounceMs: params.settings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS,
        lastEnqueuedAt: enqueuedAt,
        dropPolicy: params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
        droppedCount: overflowQueue.droppedCount,
        summaryLines: overflowQueue.summaryLines,
      },
    };
  }

  private listPendingLocalMessages(params: {
    sessionKey: string;
    agentId?: string;
  }): LocalPendingMessage[] {
    const pending: LocalPendingMessage[] = [];
    for (const run of this.runs.values()) {
      if (!this.isSameRunScope(run, params) || !run.pendingQueue) {
        continue;
      }
      run.pendingQueue.messages.forEach((message, messageIndex) => {
        pending.push({ run, messageIndex, message });
      });
    }
    return pending;
  }

  private findQueuedSessionRunPromise(params: {
    sessionKey: string;
    agentId?: string;
  }): QueuedSessionRun | undefined {
    let queuedAfter: QueuedSessionRun | undefined;
    for (const [runId, run] of this.runs) {
      if (this.isSameRunScope(run, params) && !run.isBtw) {
        const promise = this.runPromises.get(runId);
        if (promise) {
          queuedAfter = { runId, run, promise };
        }
      }
    }
    return queuedAfter;
  }

  private abortSessionRuns(params: { sessionKey: string; agentId?: string }) {
    for (const [runId, run] of this.runs) {
      if (this.isSameRunScope(run, params) && !run.isBtw && this.isAbortableRun(runId, run)) {
        run.controller.abort();
      }
    }
  }

  private hasAbortableSessionRun(params: { sessionKey: string; agentId?: string }): boolean {
    for (const [runId, run] of this.runs) {
      if (this.isSameRunScope(run, params) && !run.isBtw && this.isAbortableRun(runId, run)) {
        return true;
      }
    }
    return false;
  }

  private isSameRunScope(run: LocalRunState, params: { sessionKey: string; agentId?: string }) {
    if (run.sessionKey !== params.sessionKey) {
      return false;
    }
    if (params.sessionKey !== "global") {
      return true;
    }
    return run.agentId === params.agentId;
  }

  private isAbortableRun(runId: string, run: LocalRunState): boolean {
    return !run.lifecycleEnded || this.runPromises.has(runId);
  }

  private nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  private emit(event: string, payload: unknown) {
    this.onEvent?.({
      event,
      payload,
      seq: this.nextSeq(),
    });
  }

  private clearPendingLifecycleError(runId: string) {
    const pending = this.pendingLifecycleErrors.get(runId);
    if (!pending) {
      return;
    }
    clearTimeout(pending);
    this.pendingLifecycleErrors.delete(runId);
  }

  private clearPendingLifecycleErrors() {
    for (const pending of this.pendingLifecycleErrors.values()) {
      clearTimeout(pending);
    }
    this.pendingLifecycleErrors.clear();
  }

  private scheduleChatError(runId: string, run: LocalRunState, errorMessage?: string) {
    this.clearPendingLifecycleError(runId);
    const timer = setTimeout(() => {
      this.pendingLifecycleErrors.delete(runId);
      this.emitChatError(runId, run, errorMessage);
    }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
    timer.unref?.();
    this.pendingLifecycleErrors.set(runId, timer);
  }

  private emitChatDelta(runId: string, run: LocalRunState) {
    const normalizedText = normalizeLiveAssistantBufferedText(run.buffer).trim();
    const projected = projectLiveAssistantBufferedText(normalizedText, {
      suppressLeadFragments: true,
    });
    const text = projected.text.trim();
    if (!text || projected.suppress) {
      return;
    }
    const deltaPayload = resolveDeltaPayload(text, run.lastBroadcastText);
    if (!deltaPayload.deltaText && !deltaPayload.replace) {
      return;
    }
    run.registered = true;
    run.lastBroadcastText = text;
    this.emit("chat", {
      runId,
      sessionKey: run.sessionKey,
      state: "delta",
      ...deltaPayload,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    });
  }

  private emitChatFinal(runId: string, run: LocalRunState, stopReason?: string) {
    this.clearPendingLifecycleError(runId);
    run.markQueuedRunReady();
    const alreadyFinal = run.finalSent;
    run.finishing = false;
    run.lifecycleEnded = true;
    run.finalSent = true;
    if (alreadyFinal) {
      return;
    }
    run.registered = true;
    run.lastBroadcastText = undefined;
    const normalizedText = normalizeLiveAssistantBufferedText(run.buffer).trim();
    const projected = projectLiveAssistantBufferedText(normalizedText, {
      suppressLeadFragments: false,
    });
    const text = projected.text.trim();
    const shouldIncludeMessage = Boolean(text) && !projected.suppress;
    this.emit("chat", {
      runId,
      sessionKey: run.sessionKey,
      state: "final",
      ...(stopReason ? { stopReason } : {}),
      ...(shouldIncludeMessage
        ? {
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            },
          }
        : {}),
    });
  }

  private emitChatAborted(runId: string, run: LocalRunState, errorMessage?: string) {
    this.clearPendingLifecycleError(runId);
    run.markQueuedRunReady();
    const alreadyFinal = run.finalSent;
    run.finishing = false;
    run.lifecycleEnded = true;
    run.finalSent = true;
    if (alreadyFinal) {
      return;
    }
    run.registered = true;
    run.lastBroadcastText = undefined;
    const diagnostic = errorMessage ?? run.toolErrorSummary;
    this.emit("chat", {
      runId,
      sessionKey: run.sessionKey,
      state: "aborted",
      ...(diagnostic ? { errorMessage: diagnostic } : {}),
    });
  }

  private emitChatError(runId: string, run: LocalRunState, errorMessage?: string) {
    this.clearPendingLifecycleError(runId);
    run.markQueuedRunReady();
    const alreadyFinal = run.finalSent;
    run.finishing = false;
    run.lifecycleEnded = true;
    run.finalSent = true;
    if (alreadyFinal) {
      return;
    }
    run.registered = true;
    run.lastBroadcastText = undefined;
    this.emit("chat", {
      runId,
      sessionKey: run.sessionKey,
      state: "error",
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  private ensureRunRegistered(runId: string, run: LocalRunState) {
    if (run.registered || run.isBtw) {
      return;
    }
    run.registered = true;
    run.lastBroadcastText = "";
    this.emit("chat", {
      runId,
      sessionKey: run.sessionKey,
      state: "delta",
      deltaText: "",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: Date.now(),
      },
    });
  }

  private handleAgentEvent(evt: AgentEventPayload) {
    const run = this.runs.get(evt.runId);
    if (!run) {
      return;
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : "";
    if (evt.stream !== "lifecycle" || lifecyclePhase !== "error") {
      this.clearPendingLifecycleError(evt.runId);
    }

    if (evt.stream !== "assistant") {
      this.ensureRunRegistered(evt.runId, run);
    }

    this.emit("agent", {
      runId: evt.runId,
      stream: evt.stream,
      data: evt.data,
    });

    if (evt.stream === "assistant" || (evt.stream === "tool" && evt.data?.phase === "start")) {
      run.toolErrorSummary = undefined;
    } else if (evt.stream === "tool" && evt.data?.phase === "result") {
      run.toolErrorSummary = readToolValidationErrorSummary(evt.data.toolErrorSummary);
    }

    const assistantLiveChatInput =
      evt.stream === "assistant" ? resolveAssistantLiveChatInput(evt.data) : undefined;
    if (
      assistantLiveChatInput &&
      !run.isBtw &&
      !shouldSuppressAssistantEventForLiveChat(evt.data)
    ) {
      run.buffer = resolveMergedAssistantText({
        previousText: run.buffer,
        nextText: assistantLiveChatInput.text,
        nextDelta: assistantLiveChatInput.delta,
      });
      this.emitChatDelta(evt.runId, run);
      return;
    }

    if (evt.stream !== "lifecycle") {
      return;
    }

    const phase = lifecyclePhase;
    const aborted = evt.data?.aborted === true || run.controller.signal.aborted;
    const toolErrorSummary = readToolValidationErrorSummary(evt.data?.toolErrorSummary);
    if (phase === "finishing") {
      run.finishing = true;
      run.markQueuedRunReady();
      run.lifecycleStopReason =
        typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
      return;
    }
    if (phase === "end") {
      run.finishing = false;
      if (aborted) {
        this.emitChatAborted(evt.runId, run, toolErrorSummary);
        return;
      }
      run.lifecycleEnded = true;
      run.markQueuedRunReady();
      run.lifecycleStopReason =
        typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
      return;
    }

    if (phase === "error") {
      run.finishing = false;
      if (aborted) {
        this.emitChatAborted(evt.runId, run, toolErrorSummary);
        return;
      }
      const errorMessage = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      run.buffer = "";
      this.scheduleChatError(evt.runId, run, errorMessage);
    }
  }

  private async runTurn(params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    message: string;
    thinking?: string;
    deliver?: boolean;
    timeoutMs?: number;
    controller: AbortController;
    queuedAfter?: QueuedSessionRun;
  }) {
    try {
      if (params.queuedAfter) {
        try {
          await waitForQueuedLocalRun(params.queuedAfter, params.runId);
        } catch (error) {
          const run = this.runs.get(params.runId);
          if (run) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.emitChatError(
              params.runId,
              run,
              `previous run did not finish cleanly: ${errorMessage}`,
            );
          }
          return;
        }
        if (params.controller.signal.aborted) {
          const run = this.runs.get(params.runId);
          if (run) {
            this.emitChatAborted(params.runId, run);
          }
          return;
        }
      }
      const activeRun = this.runs.get(params.runId);
      let message = params.message;
      if (activeRun?.pendingQueue) {
        await waitForQueueDebounce(activeRun.pendingQueue, params.controller.signal);
        if (params.controller.signal.aborted) {
          this.emitChatAborted(params.runId, activeRun);
          return;
        }
        message = buildLocalQueuedPrompt(activeRun.pendingQueue);
        delete activeRun.pendingQueue;
      }
      if (activeRun?.isBtw && activeRun.question) {
        const result = await this.runBtwTurn({
          runId: params.runId,
          sessionKey: params.sessionKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          question: activeRun.question,
          timeoutMs: params.timeoutMs,
          controller: params.controller,
        });
        const run = this.runs.get(params.runId);
        if (!run) {
          return;
        }
        if (params.controller.signal.aborted) {
          this.emitChatAborted(params.runId, run);
          return;
        }
        this.emit("chat.side_result", {
          kind: "btw",
          runId: params.runId,
          sessionKey: result.sessionKey,
          question: run.question,
          text: result.text,
          ...(result.isError ? { isError: true } : {}),
        });
        this.emitChatFinal(params.runId, run);
        return;
      }
      const loadOptions = params.agentId ? { agentId: params.agentId } : undefined;
      const { canonicalKey, entry } = loadSessionEntry(params.sessionKey, loadOptions);
      const result = await agentCommandFromIngress(
        {
          // The per-message timestamp prefix is applied at the single LLM
          // boundary (normalizeMessagesForLlmBoundary) from each message's own
          // timestamp, so the current turn and historical turns carry identical
          // bytes on the wire. See: https://github.com/openclaw/openclaw/issues/3658
          message,
          sessionKey: canonicalKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(entry?.sessionId ? { sessionId: entry.sessionId } : {}),
          thinking: params.thinking,
          deliver: params.deliver,
          channel: INTERNAL_MESSAGE_CHANNEL,
          runContext: {
            messageChannel: INTERNAL_MESSAGE_CHANNEL,
          },
          timeout: timeoutSecondsFromMs(params.timeoutMs),
          runId: params.runId,
          abortSignal: params.controller.signal,
          allowModelOverride: false,
        },
        silentRuntime,
        this.deps,
      );
      const run = this.runs.get(params.runId);
      if (!run) {
        return;
      }
      if (params.controller.signal.aborted || result?.meta?.aborted === true) {
        this.emitChatAborted(params.runId, run);
        return;
      }

      if (run.isBtw) {
        const text = payloadText(result?.payloads);
        if (run.question && text) {
          this.emit("chat.side_result", {
            kind: "btw",
            runId: params.runId,
            sessionKey: run.sessionKey,
            question: run.question,
            text,
          });
        }
        this.emitChatFinal(params.runId, run);
        return;
      }

      if (!run.finalSent) {
        const normalizedText = payloadText(result?.payloads);
        if (normalizedText && !run.buffer) {
          run.buffer = normalizedText;
        }
        const stopReason =
          run.lifecycleStopReason ??
          (typeof result?.meta?.stopReason === "string" ? result.meta.stopReason : undefined);
        this.emitChatFinal(params.runId, run, stopReason);
      }
    } catch (error) {
      const run = this.runs.get(params.runId);
      if (!run) {
        return;
      }
      if (params.controller.signal.aborted) {
        this.emitChatAborted(params.runId, run);
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitChatError(params.runId, run, errorMessage);
    } finally {
      this.runs.get(params.runId)?.markQueuedRunReady();
      this.runs.delete(params.runId);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
