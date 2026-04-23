import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { resolveHeartbeatReplyPayload } from "../auto-reply/heartbeat-reply-payload.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  isHeartbeatContentEffectivelyEmpty,
  isTaskDue,
  parseHeartbeatTasks,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
  stripHeartbeatToken,
  type HeartbeatTask,
} from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type {
  ChannelHeartbeatDeps,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import {
  archiveRemovedSessionTranscripts,
  saveSessionStore,
  updateSessionStore,
} from "../config/sessions/store.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronSession } from "../cron/isolated-agent/session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { escapeRegExp } from "../utils.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";
import {
  buildExecEventPrompt,
  buildCronEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { resolveHeartbeatReasonKind } from "./heartbeat-reason.js";
import {
  computeNextHeartbeatPhaseDueMs,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
} from "./heartbeat-schedule.js";
import {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatSummaryForAgent,
  type HeartbeatSummary,
} from "./heartbeat-summary.js";
import { createHeartbeatTypingCallbacks } from "./heartbeat-typing.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";
import {
  areHeartbeatsEnabled,
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  type HeartbeatWakeRequest,
  requestHeartbeatNow,
  setHeartbeatsEnabled,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import {
  consumeSystemEventEntries,
  peekSystemEventEntries,
  resolveSystemEventDeliveryContext,
} from "./system-events.js";

export type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    getReplyFromConfig?: typeof import("./heartbeat-runner.runtime.js").getReplyFromConfig;
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    nowMs?: () => number;
  };

const log = createSubsystemLogger("gateway/heartbeat");
let heartbeatRunnerRuntimePromise: Promise<typeof import("./heartbeat-runner.runtime.js")> | null =
  null;

function loadHeartbeatRunnerRuntime() {
  heartbeatRunnerRuntimePromise ??= import("./heartbeat-runner.runtime.js");
  return heartbeatRunnerRuntimePromise;
}

function resolveHeartbeatChannelPlugin(channel: string): ChannelPlugin | undefined {
  const activePlugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  return activePlugin ?? getChannelPlugin(channel as ChannelId);
}

export { areHeartbeatsEnabled, setHeartbeatsEnabled };
export {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatSummaryForAgent,
  type HeartbeatSummary,
} from "./heartbeat-summary.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export { isCronSystemEvent };

type HeartbeatAgentState = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  intervalMs: number;
  phaseMs: number;
  nextDueMs: number;
};

export type HeartbeatRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

function resolveHeartbeatSchedulerSeed(explicitSeed?: string) {
  const normalized = normalizeOptionalString(explicitSeed);
  if (normalized) {
    return normalized;
  }
  try {
    return loadOrCreateDeviceIdentity().deviceId;
  } catch {
    return createHash("sha256")
      .update(process.env.HOME ?? "")
      .update("\0")
      .update(process.cwd())
      .digest("hex");
  }
}

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  const list = cfg.agents?.list ?? [];
  return list.some((entry) => Boolean(entry?.heartbeat));
}

function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  const list = cfg.agents?.list ?? [];
  if (hasExplicitHeartbeatAgents(cfg)) {
    return list
      .filter((entry) => entry?.heartbeat)
      .map((entry) => {
        const id = normalizeAgentId(entry.id);
        return { agentId: id, heartbeat: resolveHeartbeatConfig(cfg, id) };
      })
      .filter((entry) => entry.agentId);
  }
  const fallbackId = resolveDefaultAgentId(cfg);
  return [{ agentId: fallbackId, heartbeat: resolveHeartbeatConfig(cfg, fallbackId) }];
}

export function resolveHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptText(heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt);
}

function resolveHeartbeatAckMaxChars(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return Math.max(
    0,
    heartbeat?.ackMaxChars ??
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
}

function isHeartbeatTypingEnabled(params: { cfg: OpenClawConfig; hasChatDelivery: boolean }) {
  if (!params.hasChatDelivery) {
    return false;
  }
  const agentCfg = params.cfg.agents?.defaults;
  const typingMode = params.cfg.session?.typingMode ?? agentCfg?.typingMode;
  return typingMode !== "never";
}

function resolveHeartbeatTypingIntervalSeconds(cfg: OpenClawConfig) {
  const agentCfg = cfg.agents?.defaults;
  const configured = agentCfg?.typingIntervalSeconds ?? cfg.session?.typingIntervalSeconds;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId?: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const store = loadSessionStore(storePath);
  const mainEntry = store[mainSessionKey];

  if (scope === "global") {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: true,
    };
  }

  if (forced && !isSubagentSessionKey(forced)) {
    const forcedCandidate = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      requestKey: forced,
      mainKey: cfg.session?.mainKey,
    });
    if (!isSubagentSessionKey(forcedCandidate)) {
      const forcedCanonical = canonicalizeMainSessionAlias({
        cfg,
        agentId: resolvedAgentId,
        sessionKey: forcedCandidate,
      });
      if (forcedCanonical !== "global" && !isSubagentSessionKey(forcedCanonical)) {
        const sessionAgentId = resolveAgentIdFromSessionKey(forcedCanonical);
        if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
          return {
            sessionKey: forcedCanonical,
            storePath,
            store,
            entry: store[forcedCanonical],
            suppressOriginatingContext: false,
          };
        }
      }
    }
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    requestKey: trimmed,
    mainKey: cfg.session?.mainKey,
  });
  if (isSubagentSessionKey(candidate)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }
  const canonical = canonicalizeMainSessionAlias({
    cfg,
    agentId: resolvedAgentId,
    sessionKey: candidate,
  });
  if (canonical !== "global" && !isSubagentSessionKey(canonical)) {
    const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
    if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
      return {
        sessionKey: canonical,
        storePath,
        store,
        entry: store[canonical],
        suppressOriginatingContext: false,
      };
    }
  }

  return {
    sessionKey: mainSessionKey,
    storePath,
    store,
    entry: mainEntry,
    suppressOriginatingContext: false,
  };
}

function resolveIsolatedHeartbeatSessionKey(params: {
  sessionKey: string;
  configuredSessionKey: string;
  sessionEntry?: { heartbeatIsolatedBaseSessionKey?: string };
}) {
  const storedBaseSessionKey = params.sessionEntry?.heartbeatIsolatedBaseSessionKey?.trim();
  if (storedBaseSessionKey) {
    const suffix = params.sessionKey.slice(storedBaseSessionKey.length);
    if (
      params.sessionKey.startsWith(storedBaseSessionKey) &&
      suffix.length > 0 &&
      /^(:heartbeat)+$/.test(suffix)
    ) {
      return {
        isolatedSessionKey: `${storedBaseSessionKey}:heartbeat`,
        isolatedBaseSessionKey: storedBaseSessionKey,
      };
    }
  }

  // Collapse repeated `:heartbeat` suffixes introduced by wake-triggered re-entry.
  // The guard on configuredSessionKey ensures we do not strip a legitimate single
  // `:heartbeat` suffix that is part of the user-configured base key itself
  // (e.g. heartbeat.session: "alerts:heartbeat"). When the configured key already
  // ends with `:heartbeat`, a forced wake passes `configuredKey:heartbeat` which
  // must be treated as a new base rather than an existing isolated key.
  const configuredSuffix = params.sessionKey.slice(params.configuredSessionKey.length);
  if (
    params.sessionKey.startsWith(params.configuredSessionKey) &&
    /^(:heartbeat)+$/.test(configuredSuffix) &&
    !params.configuredSessionKey.endsWith(":heartbeat")
  ) {
    return {
      isolatedSessionKey: `${params.configuredSessionKey}:heartbeat`,
      isolatedBaseSessionKey: params.configuredSessionKey,
    };
  }
  return {
    isolatedSessionKey: `${params.sessionKey}:heartbeat`,
    isolatedBaseSessionKey: params.sessionKey,
  };
}

function resolveStaleHeartbeatIsolatedSessionKey(params: {
  sessionKey: string;
  isolatedSessionKey: string;
  isolatedBaseSessionKey: string;
}) {
  if (params.sessionKey === params.isolatedSessionKey) {
    return undefined;
  }
  const suffix = params.sessionKey.slice(params.isolatedBaseSessionKey.length);
  if (
    params.sessionKey.startsWith(params.isolatedBaseSessionKey) &&
    suffix.length > 0 &&
    /^(:heartbeat)+$/.test(suffix)
  ) {
    return params.sessionKey;
  }
  return undefined;
}

function resolveHeartbeatReasoningPayloads(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload[] {
  const payloads = Array.isArray(replyResult) ? replyResult : replyResult ? [replyResult] : [];
  return payloads.filter((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    return text.trimStart().startsWith("Reasoning:");
  });
}

async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") {
    return;
  }
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
  if (entry.updatedAt === nextUpdatedAt) {
    return;
  }
  await updateSessionStore(storePath, (nextStore) => {
    const nextEntry = nextStore[sessionKey] ?? entry;
    if (!nextEntry) {
      return;
    }
    const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
    if (nextEntry.updatedAt === resolvedUpdatedAt) {
      return;
    }
    nextStore[sessionKey] = { ...nextEntry, updatedAt: resolvedUpdatedAt };
  });
}

function stripLeadingHeartbeatResponsePrefix(
  text: string,
  responsePrefix: string | undefined,
): string {
  const normalizedPrefix = responsePrefix?.trim();
  if (!normalizedPrefix) {
    return text;
  }

  // Require a boundary after the configured prefix so short prefixes like "Hi"
  // do not strip the beginning of normal words like "History".
  const prefixPattern = new RegExp(
    `^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`,
    "iu",
  );
  return text.replace(prefixPattern, "");
}

function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix: string | undefined,
  ackMaxChars: number,
) {
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const textForStrip = stripLeadingHeartbeatResponsePrefix(rawText, responsePrefix);
  const stripped = stripHeartbeatToken(textForStrip, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  });
  const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
  if (stripped.shouldSkip && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
    };
  }
  let finalText = stripped.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return { shouldSkip: false, text: finalText, hasMedia };
}

type HeartbeatReasonFlags = {
  isExecEventReason: boolean;
  isCronEventReason: boolean;
  isWakeReason: boolean;
};

type HeartbeatSkipReason = "empty-heartbeat-file";

type HeartbeatPreflight = HeartbeatReasonFlags & {
  session: ReturnType<typeof resolveHeartbeatSession>;
  pendingEventEntries: ReturnType<typeof peekSystemEventEntries>;
  turnSourceDeliveryContext: ReturnType<typeof resolveSystemEventDeliveryContext>;
  hasTaggedCronEvents: boolean;
  shouldInspectPendingEvents: boolean;
  skipReason?: HeartbeatSkipReason;
  tasks?: HeartbeatTask[];
  heartbeatFileContent?: string;
};

function resolveHeartbeatReasonFlags(reason?: string): HeartbeatReasonFlags {
  const reasonKind = resolveHeartbeatReasonKind(reason);
  return {
    isExecEventReason: reasonKind === "exec-event",
    isCronEventReason: reasonKind === "cron",
    isWakeReason: reasonKind === "wake" || reasonKind === "hook",
  };
}

async function resolveHeartbeatPreflight(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  forcedSessionKey?: string;
  reason?: string;
}): Promise<HeartbeatPreflight> {
  const reasonFlags = resolveHeartbeatReasonFlags(params.reason);
  const session = resolveHeartbeatSession(
    params.cfg,
    params.agentId,
    params.heartbeat,
    params.forcedSessionKey,
  );
  const pendingEventEntries = peekSystemEventEntries(session.sessionKey);
  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(pendingEventEntries);
  const hasTaggedCronEvents = pendingEventEntries.some((event) =>
    event.contextKey?.startsWith("cron:"),
  );
  // Wake-triggered runs should only inspect pending events when preflight peeks
  // the same queue that the run itself will execute/drain.
  const shouldInspectWakePendingEvents = (() => {
    if (!reasonFlags.isWakeReason) {
      return false;
    }
    if (params.heartbeat?.isolatedSession !== true) {
      return true;
    }
    const configuredSession = resolveHeartbeatSession(params.cfg, params.agentId, params.heartbeat);
    const { isolatedSessionKey } = resolveIsolatedHeartbeatSessionKey({
      sessionKey: session.sessionKey,
      configuredSessionKey: configuredSession.sessionKey,
      sessionEntry: session.entry,
    });
    return isolatedSessionKey === session.sessionKey;
  })();
  const shouldInspectPendingEvents =
    reasonFlags.isExecEventReason ||
    reasonFlags.isCronEventReason ||
    shouldInspectWakePendingEvents ||
    hasTaggedCronEvents;
  const shouldBypassFileGates =
    reasonFlags.isExecEventReason ||
    reasonFlags.isCronEventReason ||
    reasonFlags.isWakeReason ||
    hasTaggedCronEvents;
  const basePreflight = {
    ...reasonFlags,
    session,
    pendingEventEntries,
    turnSourceDeliveryContext,
    hasTaggedCronEvents,
    shouldInspectPendingEvents,
  } satisfies Omit<HeartbeatPreflight, "skipReason">;

  if (shouldBypassFileGates) {
    return basePreflight;
  }

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const heartbeatFilePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let heartbeatFileContent: string | undefined;
  try {
    heartbeatFileContent = await fs.readFile(heartbeatFilePath, "utf-8");
    const tasks = parseHeartbeatTasks(heartbeatFileContent);
    if (isHeartbeatContentEffectivelyEmpty(heartbeatFileContent) && tasks.length === 0) {
      return {
        ...basePreflight,
        skipReason: "empty-heartbeat-file",
        tasks: [],
        heartbeatFileContent,
      };
    }
    // Return tasks even if file has other content - backward compatible
    return {
      ...basePreflight,
      tasks,
      heartbeatFileContent,
    };
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) {
      // Missing HEARTBEAT.md is intentional in some setups (for example, when
      // heartbeat instructions live outside the file), so keep the run active.
      // The heartbeat prompt already says "if it exists".
      return basePreflight;
    }
    // For other read errors, proceed with heartbeat as before.
  }

  return basePreflight;
}

type HeartbeatPromptResolution = {
  prompt: string | null;
  hasExecCompletion: boolean;
  hasCronEvents: boolean;
};

function appendHeartbeatWorkspacePathHint(prompt: string, workspaceDir: string): string {
  if (!/heartbeat\.md/i.test(prompt)) {
    return prompt;
  }
  const heartbeatFilePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME).replace(/\\/g, "/");
  const hint = `When reading HEARTBEAT.md, use workspace file ${heartbeatFilePath} (exact case). Do not read docs/heartbeat.md.`;
  if (prompt.includes(hint)) {
    return prompt;
  }
  return `${prompt}\n${hint}`;
}

function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  workspaceDir: string;
  startedAt: number;
  heartbeatFileContent?: string;
}): HeartbeatPromptResolution {
  const pendingEventEntries = params.preflight.pendingEventEntries;
  const pendingEvents = params.preflight.shouldInspectPendingEvents
    ? pendingEventEntries.map((event) => event.text)
    : [];
  const cronEvents = pendingEventEntries
    .filter(
      (event) =>
        (params.preflight.isCronEventReason || event.contextKey?.startsWith("cron:")) &&
        isCronSystemEvent(event.text),
    )
    .map((event) => event.text);
  const hasExecCompletion = pendingEvents.some(isExecCompletionEvent);
  const hasCronEvents = cronEvents.length > 0;

  // If tasks are defined, build a batched prompt with due tasks
  if (params.preflight.tasks && params.preflight.tasks.length > 0) {
    const tasks = params.preflight.tasks;
    const dueTasks = tasks.filter((task) =>
      isTaskDue(
        (params.preflight.session.entry?.heartbeatTaskState as Record<string, number>)?.[task.name],
        task.interval,
        params.startedAt,
      ),
    );

    if (dueTasks.length > 0) {
      const taskList = dueTasks.map((task) => `- ${task.name}: ${task.prompt}`).join("\n");
      let prompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

After completing all due tasks, reply HEARTBEAT_OK.`;

      // Preserve HEARTBEAT.md directives (non-task content)
      if (params.heartbeatFileContent) {
        const directives = params.heartbeatFileContent
          .replace(/^[\s\S]*?^tasks:[\s\S]*?(?=^[^\s]|^$)/m, "")
          .trim();
        if (directives) {
          prompt += `\n\nAdditional context from HEARTBEAT.md:\n${directives}`;
        }
      }
      return { prompt, hasExecCompletion: false, hasCronEvents: false };
    }
    // No tasks due - skip this heartbeat to avoid wasteful API calls
    return { prompt: null, hasExecCompletion: false, hasCronEvents: false };
  }

  // Fallback to original behavior
  const basePrompt = hasExecCompletion
    ? buildExecEventPrompt({ deliverToUser: params.canRelayToUser })
    : hasCronEvents
      ? buildCronEventPrompt(cronEvents, { deliverToUser: params.canRelayToUser })
      : resolveHeartbeatPrompt(params.cfg, params.heartbeat);
  const prompt = appendHeartbeatWorkspacePathHint(basePrompt, params.workspaceDir);

  return { prompt, hasExecCompletion, hasCronEvents };
}

export async function runHeartbeatOnce(opts: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatConfig;
  reason?: string;
  deps?: HeartbeatDeps;
}): Promise<HeartbeatRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const explicitAgentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
  const forcedSessionAgentId =
    explicitAgentId.length > 0 ? undefined : parseAgentSessionKey(opts.sessionKey)?.agentId;
  const agentId = normalizeAgentId(
    explicitAgentId || forcedSessionAgentId || resolveDefaultAgentId(cfg),
  );
  const heartbeat = opts.heartbeat ?? resolveHeartbeatConfig(cfg, agentId);
  if (!areHeartbeatsEnabled()) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!isHeartbeatEnabledForAgent(cfg, agentId)) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!resolveHeartbeatIntervalMs(cfg, undefined, heartbeat)) {
    return { status: "skipped", reason: "disabled" };
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  if (!isWithinActiveHours(cfg, heartbeat, startedAt)) {
    return { status: "skipped", reason: "quiet-hours" };
  }

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  // Preflight centralizes trigger classification, event inspection, and HEARTBEAT.md gating.
  const preflight = await resolveHeartbeatPreflight({
    cfg,
    agentId,
    heartbeat,
    forcedSessionKey: opts.sessionKey,
    reason: opts.reason,
  });
  if (preflight.skipReason) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: preflight.skipReason,
      durationMs: Date.now() - startedAt,
    });
    return { status: "skipped", reason: preflight.skipReason };
  }
  const { entry, sessionKey, storePath, suppressOriginatingContext } = preflight.session;

  // Check the resolved session lane — if it is busy, skip to avoid interrupting
  // an active streaming turn.  The wake-layer retry (heartbeat-wake.ts) will
  // re-schedule this wake automatically.  See #14396 (closed without merge).
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey);
  const sessionLaneSize = (opts.deps?.getQueueSize ?? getQueueSize)(sessionLaneKey);
  if (sessionLaneSize > 0) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "requests-in-flight",
      durationMs: Date.now() - startedAt,
    });
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const previousUpdatedAt = entry?.updatedAt;

  // When isolatedSession is enabled, create a fresh session via the same
  // pattern as cron sessionTarget: "isolated". This gives the heartbeat
  // a new session ID (empty transcript) each run, avoiding the cost of
  // sending the full conversation history (~100K tokens) to the LLM.
  // Delivery routing still uses the main session entry (lastChannel, lastTo).
  const useIsolatedSession = heartbeat?.isolatedSession === true;
  const delivery = resolveHeartbeatDeliveryTarget({
    cfg,
    entry,
    heartbeat,
    // Isolated heartbeat runs drain system events from their dedicated
    // `:heartbeat` session, not from the base session we peek during preflight.
    // Reusing base-session turnSource routing here can pin later isolated runs
    // to stale channels/threads because that base-session event context remains queued.
    turnSource: useIsolatedSession ? undefined : preflight.turnSourceDeliveryContext,
  });
  const heartbeatAccountId = heartbeat?.accountId?.trim();
  if (delivery.reason === "unknown-account") {
    log.warn("heartbeat: unknown accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId ?? null,
      target: heartbeat?.target ?? "none",
    });
  } else if (heartbeatAccountId) {
    log.info("heartbeat: using explicit accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId,
      target: heartbeat?.target ?? "none",
      channel: delivery.channel,
    });
  }
  const visibility =
    delivery.channel !== "none"
      ? resolveHeartbeatVisibility({
          cfg,
          channel: delivery.channel,
          accountId: delivery.accountId,
        })
      : { showOk: false, showAlerts: true, useIndicator: true };
  const { sender } = resolveHeartbeatSenderContext({ cfg, entry, delivery });
  const responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {
    channel: delivery.channel !== "none" ? delivery.channel : undefined,
    accountId: delivery.accountId,
  }).responsePrefix;

  const canRelayToUser = Boolean(
    delivery.channel !== "none" && delivery.to && visibility.showAlerts,
  );
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({
    cfg,
    heartbeat,
    preflight,
    canRelayToUser,
    workspaceDir,
    startedAt,
    heartbeatFileContent: preflight.heartbeatFileContent,
  });

  // If no tasks are due, skip heartbeat entirely
  if (prompt === null) {
    // Wake-triggered events should stay queued when the run short-circuits:
    // no reply turn ran, so there is nothing that actually consumed that wake payload.
    const shouldConsumeInspectedEvents =
      !preflight.isWakeReason && preflight.shouldInspectPendingEvents;
    if (shouldConsumeInspectedEvents && preflight.pendingEventEntries.length > 0) {
      consumeSystemEventEntries(sessionKey, preflight.pendingEventEntries);
    }
    return { status: "skipped", reason: "no-tasks-due" };
  }

  let runSessionKey = sessionKey;
  if (useIsolatedSession) {
    const configuredSession = resolveHeartbeatSession(cfg, agentId, heartbeat);
    // Collapse only the repeated `:heartbeat` suffixes introduced by wake-triggered
    // re-entry for heartbeat-created isolated sessions. Real session keys that
    // happen to end with `:heartbeat` still get a distinct isolated sibling.
    const { isolatedSessionKey, isolatedBaseSessionKey } = resolveIsolatedHeartbeatSessionKey({
      sessionKey,
      configuredSessionKey: configuredSession.sessionKey,
      sessionEntry: entry,
    });
    const cronSession = resolveCronSession({
      cfg,
      sessionKey: isolatedSessionKey,
      agentId,
      nowMs: startedAt,
      forceNew: true,
    });
    const staleIsolatedSessionKey = resolveStaleHeartbeatIsolatedSessionKey({
      sessionKey,
      isolatedSessionKey,
      isolatedBaseSessionKey,
    });
    const removedSessionFiles = new Map<string, string | undefined>();
    if (staleIsolatedSessionKey) {
      const staleEntry = cronSession.store[staleIsolatedSessionKey];
      if (staleEntry?.sessionId) {
        removedSessionFiles.set(staleEntry.sessionId, staleEntry.sessionFile);
      }
      delete cronSession.store[staleIsolatedSessionKey];
    }
    cronSession.sessionEntry.heartbeatIsolatedBaseSessionKey = isolatedBaseSessionKey;
    cronSession.store[isolatedSessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
    if (removedSessionFiles.size > 0) {
      try {
        const referencedSessionIds = new Set(
          Object.values(cronSession.store)
            .map((sessionEntry) => sessionEntry?.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        await archiveRemovedSessionTranscripts({
          removedSessionFiles,
          referencedSessionIds,
          storePath: cronSession.storePath,
          reason: "deleted",
          restrictToStoreDir: true,
        });
      } catch (err) {
        log.warn("heartbeat: failed to archive stale isolated session transcript", {
          err: String(err),
          sessionKey: staleIsolatedSessionKey,
        });
      }
    }
    runSessionKey = isolatedSessionKey;
  }
  const activeSessionPendingEventEntries =
    runSessionKey === sessionKey
      ? preflight.pendingEventEntries
      : peekSystemEventEntries(runSessionKey);
  const hasUntrustedInspectedEvents =
    preflight.shouldInspectPendingEvents &&
    preflight.pendingEventEntries.some((event) => event.trusted === false);
  const hasUntrustedActiveSessionEvents = activeSessionPendingEventEntries.some(
    (event) => event.trusted === false,
  );
  const hasUntrustedPendingEvents = hasUntrustedInspectedEvents || hasUntrustedActiveSessionEvents;

  // Update task last run times AFTER successful heartbeat completion
  const updateTaskTimestamps = async () => {
    if (!preflight.tasks || preflight.tasks.length === 0) {
      return;
    }

    const store = loadSessionStore(storePath);
    const current = store[sessionKey];
    // Initialize stub entry on first run when current doesn't exist
    const base = current ?? {
      // Generate valid sessionId - derive from sessionKey without colons
      sessionId: sessionKey.replace(/:/g, "_"),
      updatedAt: startedAt,
      createdAt: startedAt,
      messageCount: 0,
      lastMessageAt: startedAt,
      heartbeatTaskState: {},
    };
    const taskState = { ...base.heartbeatTaskState };

    for (const task of preflight.tasks) {
      if (isTaskDue(taskState[task.name], task.interval, startedAt)) {
        taskState[task.name] = startedAt;
      }
    }

    store[sessionKey] = { ...base, heartbeatTaskState: taskState };
    await saveSessionStore(storePath, store);
  };

  const consumeInspectedSystemEvents = () => {
    if (!preflight.shouldInspectPendingEvents || preflight.pendingEventEntries.length === 0) {
      return;
    }
    consumeSystemEventEntries(sessionKey, preflight.pendingEventEntries);
  };

  const ctx = {
    Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
    From: sender,
    To: sender,
    OriginatingChannel:
      !suppressOriginatingContext && delivery.channel !== "none" ? delivery.channel : undefined,
    OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
    AccountId: delivery.accountId,
    MessageThreadId: delivery.threadId,
    Provider: hasExecCompletion ? "exec-event" : hasCronEvents ? "cron-event" : "heartbeat",
    SessionKey: runSessionKey,
    ForceSenderIsOwnerFalse: hasExecCompletion || hasUntrustedPendingEvents,
  };
  if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "alerts-disabled",
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
    });
    return { status: "skipped", reason: "alerts-disabled" };
  }

  const heartbeatOkText = responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN;
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId,
    sessionKey,
  });
  const canAttemptHeartbeatOk = Boolean(
    visibility.showOk && delivery.channel !== "none" && delivery.to,
  );
  const hasChatDelivery = Boolean(
    delivery.channel !== "none" && delivery.to && (visibility.showAlerts || visibility.showOk),
  );
  const heartbeatTypingIntervalSeconds = resolveHeartbeatTypingIntervalSeconds(cfg);
  const heartbeatChannelPlugin =
    delivery.channel !== "none" ? resolveHeartbeatChannelPlugin(delivery.channel) : undefined;
  const heartbeatTyping =
    delivery.channel !== "none" &&
    isHeartbeatTypingEnabled({
      cfg,
      hasChatDelivery,
    })
      ? createHeartbeatTypingCallbacks({
          cfg,
          target: {
            channel: delivery.channel,
            ...(delivery.to !== undefined ? { to: delivery.to } : {}),
            ...(delivery.accountId !== undefined ? { accountId: delivery.accountId } : {}),
            ...(delivery.threadId !== undefined ? { threadId: delivery.threadId } : {}),
          },
          ...(heartbeatChannelPlugin ? { plugin: heartbeatChannelPlugin } : {}),
          ...(opts.deps ? { deps: opts.deps } : {}),
          ...(heartbeatTypingIntervalSeconds !== undefined
            ? { typingIntervalSeconds: heartbeatTypingIntervalSeconds }
            : {}),
          log,
        })
      : undefined;
  const maybeSendHeartbeatOk = async () => {
    if (!canAttemptHeartbeatOk || delivery.channel === "none" || !delivery.to) {
      return false;
    }
    const heartbeatPlugin = resolveHeartbeatChannelPlugin(delivery.channel);
    if (heartbeatPlugin?.heartbeat?.checkReady) {
      const readiness = await heartbeatPlugin.heartbeat.checkReady({
        cfg,
        accountId: delivery.accountId,
        deps: opts.deps,
      });
      if (!readiness.ok) {
        return false;
      }
    }
    await deliverOutboundPayloads({
      cfg,
      channel: delivery.channel,
      to: delivery.to,
      accountId: delivery.accountId,
      threadId: delivery.threadId,
      payloads: [{ text: heartbeatOkText }],
      session: outboundSession,
      deps: opts.deps,
    });
    return true;
  };

  try {
    await heartbeatTyping?.onReplyStart();
    const heartbeatModelOverride = normalizeOptionalString(heartbeat?.model);
    const suppressToolErrorWarnings = heartbeat?.suppressToolErrorWarnings === true;
    const timeoutOverrideSeconds =
      typeof heartbeat?.timeoutSeconds === "number" ? heartbeat.timeoutSeconds : undefined;
    const bootstrapContextMode: "lightweight" | undefined =
      heartbeat?.lightContext === true ? "lightweight" : undefined;
    const replyOpts = {
      isHeartbeat: true,
      ...(heartbeatModelOverride ? { heartbeatModelOverride } : {}),
      suppressToolErrorWarnings,
      // Heartbeat timeout is a per-run override so user turns keep the global default.
      timeoutOverrideSeconds,
      bootstrapContextMode,
    };
    const getReplyFromConfig =
      opts.deps?.getReplyFromConfig ?? (await loadHeartbeatRunnerRuntime()).getReplyFromConfig;
    const replyResult = await getReplyFromConfig(ctx, replyOpts, cfg);
    const replyPayload = resolveHeartbeatReplyPayload(replyResult);
    const includeReasoning = heartbeat?.includeReasoning === true;
    const reasoningPayloads = includeReasoning
      ? resolveHeartbeatReasoningPayloads(replyResult).filter((payload) => payload !== replyPayload)
      : [];

    if (!replyPayload || !hasOutboundReplyContent(replyPayload)) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });

      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        status: "ok-empty",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        accountId: delivery.accountId,
        silent: !okSent,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : undefined,
      });
      await updateTaskTimestamps();
      consumeInspectedSystemEvents();
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const ackMaxChars = resolveHeartbeatAckMaxChars(cfg, heartbeat);
    const normalized = normalizeHeartbeatReply(replyPayload, responsePrefix, ackMaxChars);
    // For exec completion events, don't skip even if the response looks like HEARTBEAT_OK.
    // The model should be responding with exec results, not ack tokens.
    // Also, if normalized.text is empty due to token stripping but we have exec completion,
    // fall back to the original reply text.
    const execFallbackText =
      hasExecCompletion && !normalized.text.trim() && replyPayload.text?.trim()
        ? replyPayload.text.trim()
        : null;
    if (execFallbackText) {
      normalized.text = execFallbackText;
      normalized.shouldSkip = false;
    }
    const shouldSkipMain = normalized.shouldSkip && !normalized.hasMedia && !hasExecCompletion;
    if (shouldSkipMain && reasoningPayloads.length === 0) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });

      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        status: "ok-token",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        accountId: delivery.accountId,
        silent: !okSent,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-token") : undefined,
      });
      await updateTaskTimestamps();
      consumeInspectedSystemEvents();
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const mediaUrls = resolveSendableOutboundReplyParts(replyPayload).mediaUrls;

    // Suppress duplicate heartbeats (same payload) within a short window.
    // This prevents "nagging" when nothing changed but the model repeats the same items.
    const prevHeartbeatText =
      typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
    const prevHeartbeatAt =
      typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : undefined;
    const isDuplicateMain =
      !shouldSkipMain &&
      !mediaUrls.length &&
      Boolean(prevHeartbeatText.trim()) &&
      normalized.text.trim() === prevHeartbeatText.trim() &&
      typeof prevHeartbeatAt === "number" &&
      startedAt - prevHeartbeatAt < 24 * 60 * 60 * 1000;

    if (isDuplicateMain) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });

      emitHeartbeatEvent({
        status: "skipped",
        reason: "duplicate",
        preview: normalized.text.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: false,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        accountId: delivery.accountId,
      });
      await updateTaskTimestamps();
      consumeInspectedSystemEvents();
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    // Reasoning payloads are text-only; any attachments stay on the main reply.
    const previewText = shouldSkipMain
      ? reasoningPayloads
          .map((payload) => payload.text)
          .filter((text): text is string => Boolean(text?.trim()))
          .join("\n")
      : normalized.text;

    if (delivery.channel === "none" || !delivery.to) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: delivery.reason ?? "no-target",
        preview: previewText?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
        accountId: delivery.accountId,
      });
      await updateTaskTimestamps();
      consumeInspectedSystemEvents();
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    if (!visibility.showAlerts) {
      await updateTaskTimestamps();
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "skipped",
        reason: "alerts-disabled",
        preview: previewText?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        channel: delivery.channel,
        hasMedia: mediaUrls.length > 0,
        accountId: delivery.accountId,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
      });
      consumeInspectedSystemEvents();
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const deliveryAccountId = delivery.accountId;
    const heartbeatPlugin = resolveHeartbeatChannelPlugin(delivery.channel);
    if (heartbeatPlugin?.heartbeat?.checkReady) {
      const readiness = await heartbeatPlugin.heartbeat.checkReady({
        cfg,
        accountId: deliveryAccountId,
        deps: opts.deps,
      });
      if (!readiness.ok) {
        emitHeartbeatEvent({
          status: "skipped",
          reason: readiness.reason,
          preview: previewText?.slice(0, 200),
          durationMs: Date.now() - startedAt,
          hasMedia: mediaUrls.length > 0,
          channel: delivery.channel,
          accountId: delivery.accountId,
        });
        log.info("heartbeat: channel not ready", {
          channel: delivery.channel,
          reason: readiness.reason,
        });
        return { status: "skipped", reason: readiness.reason };
      }
    }

    await deliverOutboundPayloads({
      cfg,
      channel: delivery.channel,
      to: delivery.to,
      accountId: deliveryAccountId,
      session: outboundSession,
      threadId: delivery.threadId,
      payloads: [
        ...reasoningPayloads,
        ...(shouldSkipMain
          ? []
          : [
              {
                text: normalized.text,
                mediaUrls,
              },
            ]),
      ],
      deps: opts.deps,
    });

    // Record last delivered heartbeat payload for dedupe.
    if (!shouldSkipMain && normalized.text.trim()) {
      const store = loadSessionStore(storePath);
      const current = store[sessionKey];
      if (current) {
        store[sessionKey] = {
          ...current,
          lastHeartbeatText: normalized.text,
          lastHeartbeatSentAt: startedAt,
        };
        await saveSessionStore(storePath, store);
      }
    }

    emitHeartbeatEvent({
      status: "sent",
      to: delivery.to,
      preview: previewText?.slice(0, 200),
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
      channel: delivery.channel,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
    });
    await updateTaskTimestamps();
    consumeInspectedSystemEvents();
    return { status: "ran", durationMs: Date.now() - startedAt };
  } catch (err) {
    const reason = formatErrorMessage(err);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    log.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  } finally {
    heartbeatTyping?.onCleanup?.();
  }
}

export function startHeartbeatRunner(opts: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  runOnce?: typeof runHeartbeatOnce;
  stableSchedulerSeed?: string;
}): HeartbeatRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const runOnce = opts.runOnce ?? runHeartbeatOnce;
  const state = {
    cfg: opts.cfg ?? loadConfig(),
    runtime,
    schedulerSeed: resolveHeartbeatSchedulerSeed(opts.stableSchedulerSeed),
    agents: new Map<string, HeartbeatAgentState>(),
    timer: null as NodeJS.Timeout | null,
    stopped: false,
  };
  let initialized = false;

  const resolveNextDue = (
    now: number,
    intervalMs: number,
    phaseMs: number,
    prevState?: HeartbeatAgentState,
  ) =>
    resolveNextHeartbeatDueMs({
      nowMs: now,
      intervalMs,
      phaseMs,
      prev: prevState
        ? {
            intervalMs: prevState.intervalMs,
            phaseMs: prevState.phaseMs,
            nextDueMs: prevState.nextDueMs,
          }
        : undefined,
    });

  const advanceAgentSchedule = (agent: HeartbeatAgentState, now: number, reason?: string) => {
    agent.nextDueMs =
      reason === "interval"
        ? computeNextHeartbeatPhaseDueMs({
            nowMs: now,
            intervalMs: agent.intervalMs,
            phaseMs: agent.phaseMs,
          })
        : // Targeted and action-driven wakes still count as a fresh heartbeat run
          // for cooldown purposes, so keep the existing now + interval behavior.
          now + agent.intervalMs;
  };

  const scheduleNext = () => {
    if (state.stopped) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.agents.size === 0) {
      return;
    }
    const now = Date.now();
    let nextDue = Number.POSITIVE_INFINITY;
    for (const agent of state.agents.values()) {
      if (agent.nextDueMs < nextDue) {
        nextDue = agent.nextDueMs;
      }
    }
    if (!Number.isFinite(nextDue)) {
      return;
    }
    const delay = Math.max(0, nextDue - now);
    state.timer = setTimeout(() => {
      state.timer = null;
      requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });
    }, delay);
    state.timer.unref?.();
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    if (state.stopped) {
      return;
    }
    const now = Date.now();
    const prevAgents = state.agents;
    const prevEnabled = prevAgents.size > 0;
    const nextAgents = new Map<string, HeartbeatAgentState>();
    const intervals: number[] = [];
    for (const agent of resolveHeartbeatAgents(cfg)) {
      const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat);
      if (!intervalMs) {
        continue;
      }
      const phaseMs = resolveHeartbeatPhaseMs({
        schedulerSeed: state.schedulerSeed,
        agentId: agent.agentId,
        intervalMs,
      });
      intervals.push(intervalMs);
      const prevState = prevAgents.get(agent.agentId);
      const nextDueMs = resolveNextDue(now, intervalMs, phaseMs, prevState);
      nextAgents.set(agent.agentId, {
        agentId: agent.agentId,
        heartbeat: agent.heartbeat,
        intervalMs,
        phaseMs,
        nextDueMs,
      });
    }

    state.cfg = cfg;
    state.agents = nextAgents;
    const nextEnabled = nextAgents.size > 0;
    if (!initialized) {
      if (!nextEnabled) {
        log.info("heartbeat: disabled", { enabled: false });
      } else {
        log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
      }
      initialized = true;
    } else if (prevEnabled !== nextEnabled) {
      if (!nextEnabled) {
        log.info("heartbeat: disabled", { enabled: false });
      } else {
        log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
      }
    }

    scheduleNext();
  };

  const run: HeartbeatWakeHandler = async (params) => {
    if (state.stopped) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }
    if (!areHeartbeatsEnabled()) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }
    if (state.agents.size === 0) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }

    const reason = params?.reason;
    const requestedAgentId = params?.agentId ? normalizeAgentId(params.agentId) : undefined;
    const requestedSessionKey = normalizeOptionalString(params?.sessionKey);
    const requestedHeartbeat = params?.heartbeat;
    const resolveRequestedHeartbeat = (heartbeat?: HeartbeatConfig) =>
      requestedHeartbeat ? { ...heartbeat, ...requestedHeartbeat } : heartbeat;
    const isInterval = reason === "interval";
    const startedAt = Date.now();
    const now = startedAt;
    let ran = false;
    // Track requests-in-flight so we can skip re-arm in finally — the wake
    // layer handles retry for this case (DEFAULT_RETRY_MS = 1 s).
    let requestsInFlight = false;

    try {
      if (requestedSessionKey || requestedAgentId) {
        const targetAgentId = requestedAgentId ?? resolveAgentIdFromSessionKey(requestedSessionKey);
        const targetAgent = state.agents.get(targetAgentId);
        if (!targetAgent) {
          return { status: "skipped", reason: "disabled" };
        }
        try {
          const res = await runOnce({
            cfg: state.cfg,
            agentId: targetAgent.agentId,
            heartbeat: resolveRequestedHeartbeat(targetAgent.heartbeat),
            reason,
            sessionKey: requestedSessionKey,
            deps: { runtime: state.runtime },
          });
          if (res.status !== "skipped" || res.reason !== "disabled") {
            advanceAgentSchedule(targetAgent, now, reason);
          }
          return res.status === "ran" ? { status: "ran", durationMs: Date.now() - startedAt } : res;
        } catch (err) {
          const errMsg = formatErrorMessage(err);
          log.error(`heartbeat runner: targeted runOnce threw unexpectedly: ${errMsg}`, {
            error: errMsg,
          });
          advanceAgentSchedule(targetAgent, now, reason);
          return { status: "failed", reason: errMsg };
        }
      }

      for (const agent of state.agents.values()) {
        if (isInterval && now < agent.nextDueMs) {
          continue;
        }

        let res: HeartbeatRunResult;
        try {
          res = await runOnce({
            cfg: state.cfg,
            agentId: agent.agentId,
            heartbeat: agent.heartbeat,
            reason,
            deps: { runtime: state.runtime },
          });
        } catch (err) {
          const errMsg = formatErrorMessage(err);
          log.error(`heartbeat runner: runOnce threw unexpectedly: ${errMsg}`, { error: errMsg });
          advanceAgentSchedule(agent, now, reason);
          continue;
        }
        if (res.status === "skipped" && res.reason === "requests-in-flight") {
          // Do not advance the schedule — the main lane is busy and the wake
          // layer will retry shortly (DEFAULT_RETRY_MS = 1 s).  Calling
          // scheduleNext() here would register a 0 ms timer that races with
          // the wake layer's 1 s retry and wins, bypassing the cooldown.
          requestsInFlight = true;
          return res;
        }
        if (res.status !== "skipped" || res.reason !== "disabled") {
          advanceAgentSchedule(agent, now, reason);
        }
        if (res.status === "ran") {
          ran = true;
        }
      }

      if (ran) {
        return { status: "ran", durationMs: Date.now() - startedAt };
      }
      return { status: "skipped", reason: isInterval ? "not-due" : "disabled" };
    } finally {
      // Always re-arm the timer — except for requests-in-flight, where the
      // wake layer (heartbeat-wake.ts) handles retry via schedule(DEFAULT_RETRY_MS).
      if (!requestsInFlight) {
        scheduleNext();
      }
    }
  };

  const wakeHandler: HeartbeatWakeHandler = async (params: HeartbeatWakeRequest) =>
    run({
      reason: params.reason,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      heartbeat: params.heartbeat,
    });
  const disposeWakeHandler = setHeartbeatWakeHandler(wakeHandler);
  updateConfig(state.cfg);

  const cleanup = () => {
    if (state.stopped) {
      return;
    }
    state.stopped = true;
    disposeWakeHandler();
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = null;
  };

  opts.abortSignal?.addEventListener("abort", cleanup, { once: true });

  return { stop: cleanup, updateConfig };
}
