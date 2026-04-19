import { hasAnyAuthProfileStoreSource } from "../../agents/auth-profiles/source-check.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob, CronRunTelemetry } from "../types.js";
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
  resolveSessionTranscriptPath,
  resolveThinkingDefault,
  setSessionRuntimeModel,
  supportsXHighThinking,
} from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { resolveCronSession } from "./session.js";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

let sessionStoreRuntimePromise:
  | Promise<typeof import("../../config/sessions/store.runtime.js")>
  | undefined;
let cronExecutorRuntimePromise: Promise<typeof import("./run-executor.runtime.js")> | undefined;
let cronExternalContentRuntimePromise:
  | Promise<typeof import("./run-external-content.runtime.js")>
  | undefined;
let cronAuthProfileRuntimePromise:
  | Promise<typeof import("./run-auth-profile.runtime.js")>
  | undefined;
let cronContextRuntimePromise: Promise<typeof import("./run-context.runtime.js")> | undefined;
let cronModelCatalogRuntimePromise:
  | Promise<typeof import("./run-model-catalog.runtime.js")>
  | undefined;
let cronDeliveryRuntimePromise: Promise<typeof import("./run-delivery.runtime.js")> | undefined;

async function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return await sessionStoreRuntimePromise;
}

async function loadCronExecutorRuntime() {
  cronExecutorRuntimePromise ??= import("./run-executor.runtime.js");
  return await cronExecutorRuntimePromise;
}

async function loadCronExternalContentRuntime() {
  cronExternalContentRuntimePromise ??= import("./run-external-content.runtime.js");
  return await cronExternalContentRuntimePromise;
}

async function loadCronAuthProfileRuntime() {
  cronAuthProfileRuntimePromise ??= import("./run-auth-profile.runtime.js");
  return await cronAuthProfileRuntimePromise;
}

async function loadCronContextRuntime() {
  cronContextRuntimePromise ??= import("./run-context.runtime.js");
  return await cronContextRuntimePromise;
}

async function loadCronModelCatalogRuntime() {
  cronModelCatalogRuntimePromise ??= import("./run-model-catalog.runtime.js");
  return await cronModelCatalogRuntimePromise;
}

async function loadCronDeliveryRuntime() {
  cronDeliveryRuntimePromise ??= import("./run-delivery.runtime.js");
  return await cronDeliveryRuntimePromise;
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

export type { RunCronAgentTurnResult } from "./run.types.js";

type CronExecutionRuntime = typeof import("./run-executor.runtime.js");
type CronExecutionResult = Awaited<ReturnType<CronExecutionRuntime["executeCronRun"]>>;
type CronModelCatalogRuntime = typeof import("./run-model-catalog.runtime.js");
type CronDeliveryRuntime = typeof import("./run-delivery.runtime.js");
type ResolvedCronDeliveryTarget = Awaited<ReturnType<CronDeliveryRuntime["resolveDeliveryTarget"]>>;

type IsolatedDeliveryContract = "cron-owned" | "shared";

function resolveCronToolPolicy(params: {
  deliveryRequested: boolean;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  deliveryMode: "announce" | "webhook" | "none";
}) {
  return {
    // Only enforce an explicit message target when the cron delivery target
    // was successfully resolved. When resolution fails the agent should not
    // be blocked by a target it cannot satisfy (#27898).
    requireExplicitMessageTarget: params.deliveryRequested && params.resolvedDelivery.ok,
    disableMessageTool: params.deliveryMode !== "none",
  };
}

async function resolveCronDeliveryContext(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  deliveryContract: IsolatedDeliveryContract;
}) {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  if (!deliveryPlan.requested) {
    const resolvedDelivery = {
      ok: false as const,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit" as const,
      error: new Error("cron delivery not requested"),
    };
    return {
      deliveryPlan,
      deliveryRequested: false,
      resolvedDelivery,
      toolPolicy: resolveCronToolPolicy({
        deliveryRequested: false,
        resolvedDelivery,
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
      deliveryRequested: deliveryPlan.requested,
      resolvedDelivery,
      deliveryMode: deliveryPlan.mode,
    }),
  };
}

function appendCronDeliveryInstruction(params: {
  commandBody: string;
  deliveryRequested: boolean;
}) {
  if (!params.deliveryRequested) {
    return params.commandBody;
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
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deliveryContract?: IsolatedDeliveryContract;
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
  resolvedDelivery: ResolvedCronDeliveryTarget;
  deliveryRequested: boolean;
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
    runSessionKey,
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
  });
  if (!resolvedModelSelection.ok) {
    return {
      ok: false,
      result: withRunSession({ status: "error", error: resolvedModelSelection.error }),
    };
  }
  let provider = resolvedModelSelection.provider;
  let model = resolvedModelSelection.model;
  if (resolvedModelSelection.warning) {
    logWarn(resolvedModelSelection.warning);
  }

  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(input.cfg.hooks?.gmail?.thinking)
    : undefined;
  const jobThink = normalizeThinkLevel(
    (input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : undefined) ?? undefined,
  );
  let thinkLevel: ThinkLevel | undefined = jobThink ?? hooksGmailThinking;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      catalog: await loadCatalog(),
    });
  }
  if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    logWarn(
      `[cron:${input.job.id}] Thinking level "xhigh" is not supported for ${provider}/${model}; downgrading to "high".`,
    );
    thinkLevel = "high";
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : undefined,
  });
  const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
  const { deliveryRequested, resolvedDelivery, toolPolicy } = await resolveCronDeliveryContext({
    cfg: cfgWithAgentDefaults,
    job: input.job,
    agentId,
    deliveryContract: input.deliveryContract ?? "cron-owned",
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
  commandBody = appendCronDeliveryInstruction({ commandBody, deliveryRequested });

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
      resolvedDelivery,
      deliveryRequested,
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
    if (runEstimatedCostUsd !== undefined) {
      prepared.cronSession.sessionEntry.estimatedCostUsd =
        (resolveNonNegativeNumber(prepared.cronSession.sessionEntry.estimatedCostUsd) ?? 0) +
        runEstimatedCostUsd;
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
    return prepared.withRunSession({ status: "error", error: params.abortReason(), ...telemetry });
  }
  let {
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
    deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    embeddedRunError,
  } = resolveCronPayloadOutcome({
    payloads,
    runLevelError: finalRunResult.meta?.error,
    finalAssistantVisibleText: finalRunResult.meta?.finalAssistantVisibleText,
    preferFinalAssistantVisibleText: prepared.resolvedDelivery.channel === "telegram",
  });
  const resolveRunOutcome = (result?: { delivered?: boolean; deliveryAttempted?: boolean }) =>
    prepared.withRunSession({
      status: hasFatalErrorPayload ? "error" : "ok",
      ...(hasFatalErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: result?.delivered,
      deliveryAttempted: result?.deliveryAttempted,
      ...telemetry,
    });

  const skipHeartbeatDelivery =
    prepared.deliveryRequested &&
    isHeartbeatOnlyResponse(payloads, resolveHeartbeatAckMaxChars(prepared.agentCfg));
  const {
    dispatchCronDelivery,
    matchesMessagingToolDeliveryTarget,
    resolveCronDeliveryBestEffort,
  } = await loadCronDeliveryRuntime();
  const skipMessagingToolDelivery =
    (prepared.input.deliveryContract ?? "cron-owned") === "shared" &&
    prepared.deliveryRequested &&
    finalRunResult.didSendViaMessagingTool === true &&
    (finalRunResult.messagingToolSentTargets ?? []).some((target) =>
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
    runSessionId: prepared.runSessionId,
    runStartedAt: execution.runStartedAt,
    runEndedAt: execution.runEndedAt,
    timeoutMs: prepared.timeoutMs,
    resolvedDelivery: prepared.resolvedDelivery,
    deliveryRequested: prepared.deliveryRequested,
    skipHeartbeatDelivery,
    skipMessagingToolDelivery,
    deliveryBestEffort: resolveCronDeliveryBestEffort(prepared.input.job),
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    summary,
    outputText,
    telemetry,
    abortSignal: prepared.input.abortSignal ?? prepared.input.signal,
    isAborted: params.isAborted,
    abortReason: params.abortReason,
    withRunSession: prepared.withRunSession,
  });
  if (deliveryResult.result) {
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
    };
    if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
    });
  }
  summary = deliveryResult.summary;
  outputText = deliveryResult.outputText;
  return resolveRunOutcome({
    delivered: deliveryResult.delivered,
    deliveryAttempted: deliveryResult.deliveryAttempted,
  });
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deliveryContract?: IsolatedDeliveryContract;
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

  try {
    const { executeCronRun } = await loadCronExecutorRuntime();
    const execution = await executeCronRun({
      cfg: params.cfg,
      cfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,
      job: params.job,
      agentId: prepared.context.agentId,
      agentDir: prepared.context.agentDir,
      agentSessionKey: prepared.context.agentSessionKey,
      workspaceDir: prepared.context.workspaceDir,
      lane: params.lane,
      resolvedDelivery: {
        channel: prepared.context.resolvedDelivery.channel,
        accountId: prepared.context.resolvedDelivery.accountId,
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
      abortReason,
      isAborted,
      thinkLevel: prepared.context.thinkLevel,
      timeoutMs: prepared.context.timeoutMs,
    });
    if (isAborted()) {
      return prepared.context.withRunSession({ status: "error", error: abortReason() });
    }
    return await finalizeCronRun({
      prepared: prepared.context,
      execution,
      abortReason,
      isAborted,
    });
  } catch (err) {
    return prepared.context.withRunSession({ status: "error", error: String(err) });
  }
}
