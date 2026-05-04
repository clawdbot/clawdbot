import { hasAnyAuthProfileStoreSource } from "../../agents/auth-profiles/source-check.js";
import { retireSessionMcpRuntime } from "../../agents/pi-bundle-mcp-tools.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveCronDeliveryPlan, type CronDeliveryPlan } from "../delivery-plan.js";
import {
  createCronRunDiagnosticsFromAgentResult,
  createCronRunDiagnosticsFromError,
  mergeCronRunDiagnostics,
} from "../run-diagnostics.js";
import type {
  CronAgentExecutionStarted,
  CronDeliveryTrace,
  CronDeliveryTraceMessageTarget,
  CronDeliveryTraceTarget,
  CronJob,
  CronRunTelemetry,
} from "../types.js";
import { resolveCronChannelOutputPolicy } from "./channel-output-policy.js";
import {
  isHeartbeatOnlyResponse,
  resolveCronPayloadOutcome,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";
import {
  createPersistCronSessionEntry,
  markCronSessionPreRun,
  persistCronSkillsSnapshotIfChanged,
  type CronLiveSelection,
  type MutableCronSession,
  type PersistCronSessionEntry,
} from "./run-session-state.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  deriveSessionTotalTokens,
  ensureAgentWorkspace,
  hasNonzeroUsage,
  isCliProvider,
  isExternalHookSession,
  logWarn,
  mapHookExternalContentSource,
  normalizeAgentId,
  normalizeThinkLevel,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentTimeoutMs,
  resolveAgentWorkspaceDir,
  resolveCronStyleNow,
  resolveDefaultAgentId,
  resolveHookExternalContentSource,
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
  resolveSessionTranscriptPath,
  resolveThinkingDefault,
  setSessionRuntimeModel,
} from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { resolveCronSession } from "./session.js";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

const sessionStoreRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/store.runtime.js"),
);
const cronExecutorRuntimeLoader = createLazyImportLoader(() => import("./run-executor.runtime.js"));
const cronExternalContentRuntimeLoader = createLazyImportLoader(
  () => import("./run-external-content.runtime.js"),
);
const cronAuthProfileRuntimeLoader = createLazyImportLoader(
  () => import("./run-auth-profile.runtime.js"),
);
const cronContextRuntimeLoader = createLazyImportLoader(() => import("./run-context.runtime.js"));
const cronModelCatalogRuntimeLoader = createLazyImportLoader(
  () => import("./run-model-catalog.runtime.js"),
);
const cronDeliveryRuntimeLoader = createLazyImportLoader(() => import("./run-delivery.runtime.js"));
const cronModelPreflightRuntimeLoader = createLazyImportLoader(
  () => import("./model-preflight.runtime.js"),
);

async function loadSessionStoreRuntime() {
  return await sessionStoreRuntimeLoader.load();
}

async function loadCronExecutorRuntime() {
  return await cronExecutorRuntimeLoader.load();
}

async function loadCronExternalContentRuntime() {
  return await cronExternalContentRuntimeLoader.load();
}

async function loadCronAuthProfileRuntime() {
  return await cronAuthProfileRuntimeLoader.load();
}

async function loadCronContextRuntime() {
  return await cronContextRuntimeLoader.load();
}

async function loadCronModelCatalogRuntime() {
  return await cronModelCatalogRuntimeLoader.load();
}

async function loadCronDeliveryRuntime() {
  return await cronDeliveryRuntimeLoader.load();
}

async function loadCronModelPreflightRuntime() {
  return await cronModelPreflightRuntimeLoader.load();
}

function hasConfiguredAuthProfiles(cfg: OpenClawConfig): boolean {
  return (
    Boolean(cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) ||
    Boolean(cfg.auth?.order && Object.keys(cfg.auth.order).length > 0)
  );
}

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function retireRolledCronSessionMcpRuntime(params: {
  job: CronJob;
  cronSession: MutableCronSession;
}) {
  if (params.job.sessionTarget === "isolated") {
    return;
  }
  const previousSessionId = normalizeOptionalString(params.cronSession.previousSessionId);
  const currentSessionId = normalizeOptionalString(params.cronSession.sessionEntry.sessionId);
  if (!previousSessionId || previousSessionId === currentSessionId) {
    return;
  }
  await retireSessionMcpRuntime({
    sessionId: previousSessionId,
    reason: "cron-session-rollover",
    onError: (error, sessionId) => {
      logWarn(
        `[cron:${params.job.id}] Failed to dispose retired bundle MCP runtime for session ${sessionId}: ${String(error)}`,
      );
    },
  });
}

export type { RunCronAgentTurnResult } from "./run.types.js";

type CronExecutionRuntime = typeof import("./run-executor.runtime.js");
type CronExecutionResult = Awaited<ReturnType<CronExecutionRuntime["executeCronRun"]>>;
type CronModelCatalogRuntime = typeof import("./run-model-catalog.runtime.js");
type CronDeliveryRuntime = typeof import("./run-delivery.runtime.js");
type ResolvedCronDeliveryTarget = Awaited<ReturnType<CronDeliveryRuntime["resolveDeliveryTarget"]>>;

function normalizeCronTraceTarget(
  target: CronDeliveryTraceTarget | undefined,
): CronDeliveryTraceTarget | undefined {
  if (!target) {
    return undefined;
  }
  return {
    ...(target.channel ? { channel: target.channel } : {}),
    ...(target.to !== undefined ? { to: target.to } : {}),
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
    ...(target.source ? { source: target.source } : {}),
  };
}

type MessagingToolTargetMatcher = (
  target: { provider?: string; to?: string; accountId?: string },
  delivery: { channel?: string; to?: string; accountId?: string },
) => boolean;

function normalizeMessagingToolTarget(
  target: MessagingToolSend,
  resolvedDelivery: ResolvedCronDeliveryTarget,
  matchesMessagingToolDeliveryTarget: MessagingToolTargetMatcher,
): CronDeliveryTraceMessageTarget | undefined {
  const channel = target.provider?.trim();
  if (!channel) {
    return undefined;
  }
  const traceChannel =
    channel === "message" &&
    resolvedDelivery.ok &&
    matchesMessagingToolDeliveryTarget(target, {
      channel: resolvedDelivery.channel,
      to: resolvedDelivery.to,
      accountId: resolvedDelivery.accountId,
    })
      ? resolvedDelivery.channel
      : channel;
  return {
    channel: traceChannel,
    ...(target.to ? { to: target.to } : {}),
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.threadId ? { threadId: target.threadId } : {}),
  };
}

function buildResolvedCronTraceTarget(
  resolvedDelivery: ResolvedCronDeliveryTarget,
): CronDeliveryTrace["resolved"] {
  if (resolvedDelivery.ok) {
    return {
      ok: true,
      ...normalizeCronTraceTarget({
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
        threadId: resolvedDelivery.threadId,
        source: resolvedDelivery.mode === "implicit" ? "last" : "explicit",
      }),
    };
  }
  return {
    ok: false,
    ...normalizeCronTraceTarget({
      channel: resolvedDelivery.channel,
      to: resolvedDelivery.to ?? null,
      accountId: resolvedDelivery.accountId,
      threadId: resolvedDelivery.threadId,
      source: resolvedDelivery.mode === "implicit" ? "last" : "explicit",
    }),
    error: resolvedDelivery.error.message,
  };
}

function buildCronDeliveryTrace(params: {
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  messagingToolSentTargets: MessagingToolSend[];
  matchesMessagingToolDeliveryTarget: MessagingToolTargetMatcher;
  fallbackUsed: boolean;
  delivered: boolean;
}): CronDeliveryTrace {
  const intended = normalizeCronTraceTarget({
    channel: params.deliveryPlan.channel ?? "last",
    to: params.deliveryPlan.to ?? null,
    accountId: params.deliveryPlan.accountId,
    threadId: params.deliveryPlan.threadId,
    source:
      params.deliveryPlan.channel === "last" || !params.deliveryPlan.channel ? "last" : "explicit",
  });
  const includeResolved =
    params.deliveryPlan.mode !== "none" || hasExplicitCronDeliveryTarget(params.deliveryPlan);
  const resolved = includeResolved
    ? buildResolvedCronTraceTarget(params.resolvedDelivery)
    : undefined;
  const messageToolSentTo = params.messagingToolSentTargets
    .map((target) =>
      normalizeMessagingToolTarget(
        target,
        params.resolvedDelivery,
        params.matchesMessagingToolDeliveryTarget,
      ),
    )
    .filter((target): target is CronDeliveryTraceMessageTarget => Boolean(target));
  return {
    ...(intended ? { intended } : {}),
    ...(resolved ? { resolved } : {}),
    ...(messageToolSentTo.length > 0 ? { messageToolSentTo } : {}),
    fallbackUsed: params.fallbackUsed,
    delivered: params.delivered,
  };
}

function resolveMessagingToolSentTargets(params: {
  resolvedDelivery: ResolvedCronDeliveryTarget;
  runResult: CronExecutionResult["runResult"];
}): MessagingToolSend[] {
  const explicitTargets = params.runResult.messagingToolSentTargets ?? [];
  if (explicitTargets.length > 0 || params.runResult.didSendViaMessagingTool !== true) {
    return explicitTargets;
  }
  if (!params.resolvedDelivery.ok) {
    return [];
  }
  const threadId = stringifyRouteThreadId(params.resolvedDelivery.threadId);
  return [
    {
      tool: "message",
      provider: params.resolvedDelivery.channel,
      ...(params.resolvedDelivery.accountId
        ? { accountId: params.resolvedDelivery.accountId }
        : {}),
      ...(params.resolvedDelivery.to ? { to: params.resolvedDelivery.to } : {}),
      ...(threadId ? { threadId } : {}),
    },
  ];
}

function resolveCronToolPolicy(params: { deliveryMode: "announce" | "webhook" | "none" }) {
  const enableMessageTool = params.deliveryMode !== "webhook";
  return {
    requireExplicitMessageTarget: false,
    disableMessageTool: !enableMessageTool,
    forceMessageTool: enableMessageTool,
  };
}

function canPromptForMessageTool(params: {
  disableMessageTool: boolean;
  toolsAllow?: string[];
}): boolean {
  if (params.disableMessageTool) {
    return false;
  }
  return !params.toolsAllow?.length || params.toolsAllow.includes("message");
}

function hasExplicitCronDeliveryTarget(plan: CronDeliveryPlan): boolean {
  return Boolean(
    (plan.channel && plan.channel !== "last") || plan.to || plan.threadId || plan.accountId,
  );
}

async function resolveCronDeliveryContext(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
}) {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  if (deliveryPlan.mode === "webhook") {
    const resolvedDelivery = {
      ok: false as const,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit" as const,
      error: new Error("webhook delivery has no chat target"),
    };
    return {
      deliveryPlan,
      deliveryRequested: deliveryPlan.requested,
      resolvedDelivery,
      toolPolicy: resolveCronToolPolicy({
        deliveryMode: deliveryPlan.mode,
      }),
    };
  }
  if (deliveryPlan.mode === "none" && !hasExplicitCronDeliveryTarget(deliveryPlan)) {
    return {
      deliveryPlan,
      deliveryRequested: false,
      resolvedDelivery: {
        ok: false as const,
        channel: undefined,
        to: undefined,
        accountId: undefined,
        threadId: undefined,
        mode: "implicit" as const,
        error: new Error("delivery is disabled"),
      },
      toolPolicy: resolveCronToolPolicy({
        deliveryMode: deliveryPlan.mode,
      }),
    };
  }
  const { resolveDeliveryTarget } = await loadCronDeliveryRuntime();
  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    threadId: deliveryPlan.threadId,
    accountId: deliveryPlan.accountId,
    sessionKey: params.job.sessionKey,
  });
  return {
    deliveryPlan,
    deliveryRequested: deliveryPlan.requested,
    resolvedDelivery,
    toolPolicy: resolveCronToolPolicy({
      deliveryMode: deliveryPlan.mode,
    }),
  };
}

function appendCronDeliveryInstruction(params: {
  commandBody: string;
  deliveryRequested: boolean;
  messageToolEnabled: boolean;
  resolvedDeliveryOk: boolean;
}) {
  if (!params.deliveryRequested) {
    return params.commandBody;
  }
  if (params.messageToolEnabled) {
    const targetHint = params.resolvedDeliveryOk
      ? "for the current chat"
      : "with an explicit target";
    return `${params.commandBody}\n\nUse the message tool if you need to notify the user directly ${targetHint}. If you do not send directly, your final plain-text reply will be delivered automatically.`.trim();
  }
  return `${params.commandBody}\n\nReturn your response as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
}

function resolvePositiveContextTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function loadCliRunnerRuntime() {
  return await import("../../agents/cli-runner.runtime.js");
}

async function loadUsageFormatRuntime() {
  return await import("../../utils/usage-format.js");
}

type RunCronAgentTurnParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  sessionKey: string;
  agentId?: string;
  lane?: string;
};

type WithRunSession = (
  result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
) => RunCronAgentTurnResult;

type PreparedCronRunContext = {
  input: RunCronAgentTurnParams;
  cfgWithAgentDefaults: OpenClawConfig;
  agentId: string;
  agentCfg: AgentDefaultsConfig;
  agentDir: string;
  agentSessionKey: string;
  runSessionId: string;
  runSessionKey: string;
  workspaceDir: string;
  commandBody: string;
  cronSession: MutableCronSession;
  persistSessionEntry: PersistCronSessionEntry;
  withRunSession: WithRunSession;
  agentPayload: Extract<CronJob["payload"], { kind: "agentTurn" }> | null;
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  deliveryRequested: boolean;
  suppressExecNotifyOnExit: boolean;
  toolPolicy: ReturnType<typeof resolveCronToolPolicy>;
  skillsSnapshot: SkillSnapshot;
  liveSelection: CronLiveSelection;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
};

type CronPreparationResult =
  | { ok: true; context: PreparedCronRunContext }
  | { ok: false; result: RunCronAgentTurnResult };

async function prepareCronRunContext(params: {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
}): Promise<CronPreparationResult> {
  const { input } = params;
  const defaultAgentId = resolveDefaultAgentId(input.cfg);
  const requestedAgentId =
    typeof input.agentId === "string" && input.agentId.trim()
      ? input.agentId
      : typeof input.job.agentId === "string" && input.job.agentId.trim()
        ? input.job.agentId
        : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(input.cfg, normalizedRequested)
    : undefined;
  const agentId = normalizedRequested ?? defaultAgentId;
  const agentCfg: AgentDefaultsConfig = buildCronAgentDefaultsConfig({
    defaults: input.cfg.agents?.defaults,
    agentConfigOverride,
  });
  const cfgWithAgentDefaults: OpenClawConfig = {
    ...input.cfg,
    agents: Object.assign({}, input.cfg.agents, { defaults: agentCfg }),
  };
  let catalog: Awaited<ReturnType<CronModelCatalogRuntime["loadModelCatalog"]>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await (
        await loadCronModelCatalogRuntime()
      ).loadModelCatalog({
        config: cfgWithAgentDefaults,
      });
    }
    return catalog;
  };

  const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: baseSessionKey,
    agentId,
    mainKey: input.cfg.session?.mainKey,
    cfg: input.cfg,
  });
  const payloadHookExternalContentSource =
    input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : undefined;
  const hookExternalContentSource =
    payloadHookExternalContentSource ?? resolveHookExternalContentSource(baseSessionKey);

  const workspaceDirRaw = resolveAgentWorkspaceDir(input.cfg, agentId);
  const agentDir = resolveAgentDir(input.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !params.isFastTestEnv,
    skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
  });
  const workspaceDir = workspace.dir;

  const isGmailHook = hookExternalContentSource === "gmail";
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: input.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
    forceNew: input.job.sessionTarget === "isolated",
  });
  const runSessionId = cronSession.sessionEntry.sessionId;
  if (!cronSession.sessionEntry.sessionFile?.trim()) {
    cronSession.sessionEntry.sessionFile = resolveSessionTranscriptPath(runSessionId, agentId);
  }
  const runSessionKey = baseSessionKey.startsWith("cron:")
    ? `${agentSessionKey}:run:${runSessionId}`
    : agentSessionKey;
  const persistSessionEntry = createPersistCronSessionEntry({
    isFastTestEnv: params.isFastTestEnv,
    cronSession,
    agentSessionKey,
    updateSessionStore: async (storePath, update) => {
      const { updateSessionStore } = await loadSessionStoreRuntime();
      await updateSessionStore(storePath, update);
    },
  });
  const withRunSession: WithRunSession = (result) => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: runSessionKey,
  });
  if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
    const labelSuffix =
      typeof input.job.name === "string" && input.job.name.trim()
        ? input.job.name.trim()
        : input.job.id;
    cronSession.sessionEntry.label = `Cron: ${labelSuffix}`;
  }

  const resolvedModelSelection = await resolveCronModelSelection({
    cfg: input.cfg,
    cfgWithAgentDefaults,
    agentConfigOverride,
    sessionEntry: cronSession.sessionEntry,
    payload: input.job.payload,
    isGmailHook,
    agentId,
  });
  if (!resolvedModelSelection.ok) {
    return {
      ok: false,
      result: withRunSession({
        status: "error",
        error: resolvedModelSelection.error,
        diagnostics: createCronRunDiagnosticsFromError(
          "cron-preflight",
          resolvedModelSelection.error,
        ),
      }),
    };
  }
  let provider = resolvedModelSelection.provider;
  let model = resolvedModelSelection.model;

  const preflight = await (
    await loadCronModelPreflightRuntime()
  ).preflightCronModelProvider({
    cfg: cfgWithAgentDefaults,
    provider,
    model,
  });
  if (preflight.status === "unavailable") {
    logWarn(`[cron:${input.job.id}] ${preflight.reason}`);
    return {
      ok: false,
      result: withRunSession({
        status: "skipped",
        error: preflight.reason,
        diagnostics: createCronRunDiagnosticsFromError("model-preflight", preflight.reason, {
          severity: "warn",
        }),
        provider,
        model,
      }),
    };
  }

  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(input.cfg.hooks?.gmail?.thinking)
    : undefined;
  const jobThink = normalizeThinkLevel(
    (input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : undefined) ?? undefined,
  );
  let thinkLevel: ThinkLevel | undefined = jobThink ?? hooksGmailThinking;
  if (!thinkLevel) {
    const thinkingCatalog = await loadCatalog();
    thinkLevel = resolveThinkingDefault({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      catalog: thinkingCatalog,
    });
  }
  const thinkingCatalog = await loadCatalog();
  if (!isThinkingLevelSupported({ provider, model, level: thinkLevel, catalog: thinkingCatalog })) {
    const fallbackThinkLevel = resolveSupportedThinkingLevel({
      provider,
      model,
      level: thinkLevel,
      catalog: thinkingCatalog,
    });
    if (fallbackThinkLevel !== thinkLevel) {
      logWarn(
        `[cron:${input.job.id}] Thinking level "${thinkLevel}" is not supported for ${provider}/${model}; downgrading to "${fallbackThinkLevel}".`,
      );
      thinkLevel = fallbackThinkLevel;
    }
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : undefined,
  });
  const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
  const { deliveryPlan, deliveryRequested, resolvedDelivery, toolPolicy } =
    await resolveCronDeliveryContext({
      cfg: cfgWithAgentDefaults,
      job: input.job,
      agentId,
    });

  const { formattedTime, timeLine } = resolveCronStyleNow(input.cfg, now);
  const base = `[cron:${input.job.id} ${input.job.name}] ${input.message}`.trim();
  const isExternalHook =
    hookExternalContentSource !== undefined || isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    agentPayload?.allowUnsafeExternalContent === true ||
    (isGmailHook && input.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    const { detectSuspiciousPatterns } = await loadCronExternalContentRuntime();
    const suspiciousPatterns = detectSuspiciousPatterns(input.message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    const { buildSafeExternalPrompt } = await loadCronExternalContentRuntime();
    const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
    const safeContent = buildSafeExternalPrompt({
      content: input.message,
      source: hookType,
      jobName: input.job.name,
      jobId: input.job.id,
      timestamp: formattedTime,
    });
    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    commandBody = `${base}\n${timeLine}`.trim();
  }
  commandBody = appendCronDeliveryInstruction({
    commandBody,
    deliveryRequested,
    messageToolEnabled: canPromptForMessageTool({
      disableMessageTool: toolPolicy.disableMessageTool,
      toolsAllow: agentPayload?.toolsAllow,
    }),
    resolvedDeliveryOk: resolvedDelivery.ok,
  });

  const skillsSnapshot = await resolveCronSkillsSnapshot({
    workspaceDir,
    config: cfgWithAgentDefaults,
    agentId,
    existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
    isFastTestEnv: params.isFastTestEnv,
  });
  await persistCronSkillsSnapshotIfChanged({
    isFastTestEnv: params.isFastTestEnv,
    cronSession,
    skillsSnapshot,
    nowMs: Date.now(),
    persistSessionEntry,
  });

  markCronSessionPreRun({ entry: cronSession.sessionEntry, provider, model });
  try {
    await persistSessionEntry();
  } catch (err) {
    logWarn(`[cron:${input.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
  }
  await retireRolledCronSessionMcpRuntime({
    job: input.job,
    cronSession,
  });
  const hasSessionAuthProfileOverride = Boolean(
    cronSession.sessionEntry.authProfileOverride?.trim(),
  );
  const authProfileId =
    !hasSessionAuthProfileOverride &&
    !hasConfiguredAuthProfiles(cfgWithAgentDefaults) &&
    !hasAnyAuthProfileStoreSource(agentDir)
      ? undefined
      : await (
          await loadCronAuthProfileRuntime()
        ).resolveSessionAuthProfileOverride({
          cfg: cfgWithAgentDefaults,
          provider,
          agentDir,
          sessionEntry: cronSession.sessionEntry,
          sessionStore: cronSession.store,
          sessionKey: agentSessionKey,
          storePath: cronSession.storePath,
          isNewSession: cronSession.isNewSession && input.job.sessionTarget !== "isolated",
        });
  const liveSelection: CronLiveSelection = {
    provider,
    model,
    authProfileId,
    authProfileIdSource: authProfileId
      ? cronSession.sessionEntry.authProfileOverrideSource
      : undefined,
  };

  return {
    ok: true,
    context: {
      input,
      cfgWithAgentDefaults,
      agentId,
      agentCfg,
      agentDir,
      agentSessionKey,
      runSessionId,
      runSessionKey,
      workspaceDir,
      commandBody,
      cronSession,
      persistSessionEntry,
      withRunSession,
      agentPayload,
      deliveryPlan,
      resolvedDelivery,
      deliveryRequested,
      suppressExecNotifyOnExit: deliveryPlan.mode === "none",
      toolPolicy,
      skillsSnapshot,
      liveSelection,
      thinkLevel,
      timeoutMs,
    },
  };
}

async function finalizeCronRun(params: {
  prepared: PreparedCronRunContext;
  execution: CronExecutionResult;
  abortReason: () => string;
  isAborted: () => boolean;
}): Promise<RunCronAgentTurnResult> {
  const { prepared, execution } = params;
  const finalRunResult = execution.runResult;
  const payloads = finalRunResult.payloads ?? [];
  let telemetry: CronRunTelemetry | undefined;

  if (finalRunResult.meta?.systemPromptReport) {
    prepared.cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
  }
  const usage = finalRunResult.meta?.agentMeta?.usage;
  const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
  const modelUsed =
    finalRunResult.meta?.agentMeta?.model ??
    execution.fallbackModel ??
    execution.liveSelection.model;
  const providerUsed =
    finalRunResult.meta?.agentMeta?.provider ??
    execution.fallbackProvider ??
    execution.liveSelection.provider;
  const contextTokens =
    resolvePositiveContextTokens(prepared.agentCfg?.contextTokens) ??
    (await loadCronContextRuntime()).lookupContextTokens(modelUsed, {
      allowAsyncLoad: false,
    }) ??
    resolvePositiveContextTokens(prepared.cronSession.sessionEntry.contextTokens) ??
    DEFAULT_CONTEXT_TOKENS;

  setSessionRuntimeModel(prepared.cronSession.sessionEntry, {
    provider: providerUsed,
    model: modelUsed,
  });
  prepared.cronSession.sessionEntry.contextTokens = contextTokens;
  if (isCliProvider(providerUsed, prepared.cfgWithAgentDefaults)) {
    const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
    if (cliSessionId) {
      const { setCliSessionId } = await loadCliRunnerRuntime();
      setCliSessionId(prepared.cronSession.sessionEntry, providerUsed, cliSessionId);
    }
  }
  if (hasNonzeroUsage(usage)) {
    const { estimateUsageCost, resolveModelCostConfig } = await loadUsageFormatRuntime();
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage,
      contextTokens,
      promptTokens,
    });
    const runEstimatedCostUsd = resolveNonNegativeNumber(
      estimateUsageCost({
        usage,
        cost: resolveModelCostConfig({
          provider: providerUsed,
          model: modelUsed,
          config: prepared.cfgWithAgentDefaults,
        }),
      }),
    );
    prepared.cronSession.sessionEntry.inputTokens = input;
    prepared.cronSession.sessionEntry.outputTokens = output;
    const telemetryUsage: NonNullable<CronRunTelemetry["usage"]> = {
      input_tokens: input,
      output_tokens: output,
    };
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      prepared.cronSession.sessionEntry.totalTokens = totalTokens;
      prepared.cronSession.sessionEntry.totalTokensFresh = true;
      telemetryUsage.total_tokens = totalTokens;
    } else {
      prepared.cronSession.sessionEntry.totalTokens = undefined;
      prepared.cronSession.sessionEntry.totalTokensFresh = false;
    }
    prepared.cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
    prepared.cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;
    // Snapshot cost like tokens (runEstimatedCostUsd is already computed from
    // cumulative run usage, so assign directly instead of accumulating).
    // Fixes #69347: cost was inflated 1x-72x by accumulating on every persist.
    if (runEstimatedCostUsd !== undefined) {
      prepared.cronSession.sessionEntry.estimatedCostUsd = runEstimatedCostUsd;
    }
    telemetry = {
      model: modelUsed,
      provider: providerUsed,
      usage: telemetryUsage,
    };
  } else {
    telemetry = { model: modelUsed, provider: providerUsed };
  }
  await prepared.persistSessionEntry();

  if (params.isAborted()) {
    return prepared.withRunSession({
      status: "error",
      error: params.abortReason(),
      diagnostics: mergeCronRunDiagnostics(
        createCronRunDiagnosticsFromAgentResult(finalRunResult, { finalStatus: "error" }),
        createCronRunDiagnosticsFromError("cron-setup", params.abortReason()),
      ),
      ...telemetry,
    });
  }
  let {
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
    deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    embeddedRunError,
    pendingPresentationWarningError,
  } = resolveCronPayloadOutcome({
    payloads,
    runLevelError: finalRunResult.meta?.error,
    failureSignal: finalRunResult.meta?.failureSignal,
    finalAssistantVisibleText: finalRunResult.meta?.finalAssistantVisibleText,
    preferFinalAssistantVisibleText: (
      await resolveCronChannelOutputPolicy(prepared.resolvedDelivery.channel)
    ).preferFinalAssistantVisibleText,
  });
  const agentDiagnostics = createCronRunDiagnosticsFromAgentResult(finalRunResult, {
    finalStatus: hasFatalErrorPayload ? "error" : "ok",
  });
  const resolveRunOutcome = (result?: {
    delivered?: boolean;
    deliveryAttempted?: boolean;
    delivery?: CronDeliveryTrace;
  }) =>
    prepared.withRunSession({
      status: hasFatalErrorPayload ? "error" : "ok",
      ...(hasFatalErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: result?.delivered,
      deliveryAttempted: result?.deliveryAttempted,
      delivery: result?.delivery,
      diagnostics: hasFatalErrorPayload
        ? mergeCronRunDiagnostics(
            agentDiagnostics,
            createCronRunDiagnosticsFromError(
              "agent-run",
              embeddedRunError ?? "cron isolated run returned an error payload",
            ),
          )
        : agentDiagnostics,
      ...telemetry,
    });
  const failPendingPresentationWarningUnlessDelivered = (delivered?: boolean) => {
    if (pendingPresentationWarningError && delivered !== true) {
      hasFatalErrorPayload = true;
      embeddedRunError = pendingPresentationWarningError;
    }
  };

  const skipHeartbeatDelivery =
    prepared.deliveryRequested &&
    !hasFatalErrorPayload &&
    isHeartbeatOnlyResponse(deliveryPayloads, resolveHeartbeatAckMaxChars(prepared.agentCfg));
  const {
    dispatchCronDelivery,
    matchesMessagingToolDeliveryTarget,
    resolveCronDeliveryBestEffort,
  } = await loadCronDeliveryRuntime();
  const messagingToolSentTargets = resolveMessagingToolSentTargets({
    resolvedDelivery: prepared.resolvedDelivery,
    runResult: finalRunResult,
  });
  const didSendViaMessagingTool =
    finalRunResult.didSendViaMessagingTool === true && messagingToolSentTargets.length > 0;
  const skipMessagingToolDelivery =
    didSendViaMessagingTool &&
    prepared.resolvedDelivery.ok &&
    messagingToolSentTargets.some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: prepared.resolvedDelivery.channel,
        to: prepared.resolvedDelivery.to,
        accountId: prepared.resolvedDelivery.accountId,
      }),
    );
  const deliveryResult = await dispatchCronDelivery({
    cfg: prepared.input.cfg,
    cfgWithAgentDefaults: prepared.cfgWithAgentDefaults,
    deps: prepared.input.deps,
    job: prepared.input.job,
    agentId: prepared.agentId,
    agentSessionKey: prepared.agentSessionKey,
    runSessionKey: prepared.runSessionKey,
    sessionId: prepared.runSessionId,
    runStartedAt: execution.runStartedAt,
    runEndedAt: execution.runEndedAt,
    timeoutMs: prepared.timeoutMs,
    resolvedDelivery: prepared.resolvedDelivery,
    deliveryRequested: prepared.deliveryRequested,
    skipHeartbeatDelivery,
    skipMessagingToolDelivery,
    unverifiedMessagingToolDelivery: didSendViaMessagingTool && !prepared.resolvedDelivery.ok,
    deliveryBestEffort: resolveCronDeliveryBestEffort(prepared.input.job),
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    ttsAuto: prepared.cronSession.sessionEntry.ttsAuto,
    summary,
    outputText,
    telemetry,
    abortSignal: prepared.input.abortSignal ?? prepared.input.signal,
    isAborted: params.isAborted,
    abortReason: params.abortReason,
    withRunSession: prepared.withRunSession,
  });
  const deliveryTrace = buildCronDeliveryTrace({
    deliveryPlan: prepared.deliveryPlan,
    resolvedDelivery: prepared.resolvedDelivery,
    messagingToolSentTargets,
    matchesMessagingToolDeliveryTarget,
    fallbackUsed: deliveryResult.deliveryAttempted && !skipMessagingToolDelivery,
    delivered: deliveryResult.delivered,
  });
  if (deliveryResult.result) {
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
      delivery: deliveryTrace,
      diagnostics: mergeCronRunDiagnostics(
        agentDiagnostics,
        deliveryResult.result.diagnostics,
        deliveryResult.result.status === "error" && deliveryResult.result.error
          ? createCronRunDiagnosticsFromError("delivery", deliveryResult.result.error)
          : undefined,
      ),
    };
    failPendingPresentationWarningUnlessDelivered(
      resultWithDeliveryMeta.delivered ?? deliveryResult.delivered,
    );
    if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
      delivery: deliveryTrace,
    });
  }
  summary = deliveryResult.summary;
  outputText = deliveryResult.outputText;
  failPendingPresentationWarningUnlessDelivered(deliveryResult.delivered);
  return resolveRunOutcome({
    delivered: deliveryResult.delivered,
    deliveryAttempted: deliveryResult.deliveryAttempted,
    delivery: deliveryTrace,
  });
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  sessionKey: string;
  agentId?: string;
  lane?: string;
}): Promise<RunCronAgentTurnResult> {
  const abortSignal = params.abortSignal ?? params.signal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => {
    const reason = abortSignal?.reason;
    return typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "cron: job execution timed out";
  };
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const prepared = await prepareCronRunContext({ input: params, isFastTestEnv });
  if (!prepared.ok) {
    return prepared.result;
  }
  const notifyExecutionStarted = () =>
    params.onExecutionStarted?.({
      jobId: params.job.id,
      agentId: prepared.context.agentId,
      sessionId: prepared.context.runSessionId,
      sessionKey: prepared.context.runSessionKey,
    });

  try {
    const { executeCronRun } = await loadCronExecutorRuntime();
    const execution = await executeCronRun({
      cfg: params.cfg,
      cfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,
      job: params.job,
      agentId: prepared.context.agentId,
      agentDir: prepared.context.agentDir,
      agentSessionKey: prepared.context.agentSessionKey,
      runSessionKey: prepared.context.runSessionKey,
      workspaceDir: prepared.context.workspaceDir,
      lane: params.lane,
      resolvedDelivery: {
        channel: prepared.context.resolvedDelivery.channel,
        to: prepared.context.resolvedDelivery.to,
        accountId: prepared.context.resolvedDelivery.accountId,
        threadId: prepared.context.resolvedDelivery.threadId,
      },
      toolPolicy: prepared.context.toolPolicy,
      skillsSnapshot: prepared.context.skillsSnapshot,
      agentPayload: prepared.context.agentPayload,
      agentVerboseDefault: prepared.context.agentCfg?.verboseDefault,
      liveSelection: prepared.context.liveSelection,
      cronSession: prepared.context.cronSession,
      commandBody: prepared.context.commandBody,
      persistSessionEntry: prepared.context.persistSessionEntry,
      abortSignal,
      onExecutionStarted: notifyExecutionStarted,
      abortReason,
      isAborted,
      thinkLevel: prepared.context.thinkLevel,
      timeoutMs: prepared.context.timeoutMs,
      suppressExecNotifyOnExit: prepared.context.suppressExecNotifyOnExit,
    });
    if (isAborted()) {
      return prepared.context.withRunSession({
        status: "error",
        error: abortReason(),
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", abortReason()),
      });
    }
    return await finalizeCronRun({
      prepared: prepared.context,
      execution,
      abortReason,
      isAborted,
    });
  } catch (err) {
    return prepared.context.withRunSession({
      status: "error",
      error: String(err),
      diagnostics: createCronRunDiagnosticsFromError("agent-run", err),
    });
  }
}
