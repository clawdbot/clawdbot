import { resolveStaticSessionMcpServerNames } from "../../agents/agent-bundle-mcp-runtime-config.js";
import { resolveCodexMcpToolOverridesForAgent } from "../../agents/cli-runner/bundle-mcp-codex.js";
/** Delivery planning, prompt policy, and delivery trace construction for cron runs. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SourceDeliveryOutcome,
  SourceDeliveryVisibleDelivery,
} from "../../infra/outbound/source-delivery-plan.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  hasExplicitCronDeliveryTarget,
  resolveCronDeliveryPlan,
  type CronDeliveryPlan,
} from "../delivery-plan.js";
import {
  createCronRunDiagnosticsFromError,
  createCronRunDiagnosticsFromMissingWebSearchProvider,
  toolsAllowRequestsWebSearch,
} from "../run-diagnostics.js";
import { resolveCronDeliverySessionKey } from "../session-target.js";
import type {
  CronDeliveryTrace,
  CronDeliveryTraceMessageTarget,
  CronDeliveryTraceTarget,
  CronJob,
  CronRunDiagnostics,
  CronToolsAllowProvenance,
} from "../types.js";
import { logWarn } from "./run.runtime.js";
import { resolveCronSourceDeliveryPlan } from "./source-delivery-plan.js";

const cronDeliveryRuntimeLoader = createLazyImportLoader(() => import("./run-delivery.runtime.js"));
const codexNativeWebSearchLoader = createLazyImportLoader(
  () => import("../../agents/codex-native-web-search.js"),
);
const webToolRuntimeContextLoader = createLazyImportLoader(
  () => import("../../agents/tools/web-tool-runtime-context.js"),
);
const webSearchRuntimeLoader = createLazyImportLoader(() => import("../../web-search/runtime.js"));

export async function loadCronDeliveryRuntime() {
  return await cronDeliveryRuntimeLoader.load();
}

async function loadCodexNativeWebSearch() {
  return await codexNativeWebSearchLoader.load();
}

type CronDeliveryRuntime = typeof import("./run-delivery.runtime.js");
export type ResolvedCronDeliveryTarget = Awaited<
  ReturnType<CronDeliveryRuntime["resolveDeliveryTarget"]>
>;

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

function normalizeMessagingToolTarget(
  delivery: SourceDeliveryVisibleDelivery,
  resolvedDelivery: ResolvedCronDeliveryTarget,
): CronDeliveryTraceMessageTarget | undefined {
  const { target } = delivery;
  const channel = target.provider?.trim();
  if (!channel) {
    return undefined;
  }
  const traceChannel =
    channel === "message" && resolvedDelivery.ok && delivery.verifiedTarget
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

export function buildCronDeliveryTrace(params: {
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  sourceDeliveryOutcome: SourceDeliveryOutcome;
  fallbackUsed: boolean;
  delivered: boolean;
}): CronDeliveryTrace {
  // Trace both intended and resolved targets so run logs can explain fallback
  // delivery without leaking provider-specific raw routing internals.
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
  const messageToolSentTo = params.sourceDeliveryOutcome.visibleDeliveries
    .map((delivery) => normalizeMessagingToolTarget(delivery, params.resolvedDelivery))
    .filter((target): target is CronDeliveryTraceMessageTarget => Boolean(target));
  return {
    ...(intended ? { intended } : {}),
    ...(resolved ? { resolved } : {}),
    ...(messageToolSentTo.length > 0 ? { messageToolSentTo } : {}),
    fallbackUsed: params.fallbackUsed,
    delivered: params.delivered,
  };
}

export async function createCronToolsAllowPreflightDiagnostics(params: {
  cfg: OpenClawConfig;
  jobId: string;
  provider: string;
  model: string;
  modelApi?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir: string;
  sessionKey?: string;
  agentPayload: Extract<CronJob["payload"], { kind: "agentTurn" }> | null;
  agentRuntime?: string;
  toolsAllowProvenance?: CronToolsAllowProvenance;
}): Promise<CronRunDiagnostics | undefined> {
  const toolsAllow = params.agentPayload?.toolsAllow;
  if (params.agentPayload?.toolsAllowIsDefault === true) {
    const hasEnabledStaticMcp =
      resolveStaticSessionMcpServerNames({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        toolOverrides: resolveCodexMcpToolOverridesForAgent(params.cfg, {
          agentId: params.agentId,
          toolOverrides: undefined,
        }),
      }).length > 0;
    if (
      params.agentRuntime === "codex" &&
      hasEnabledStaticMcp &&
      params.toolsAllowProvenance?.source !== "final-executable-surface"
    ) {
      return createCronRunDiagnosticsFromError(
        "cron-preflight",
        `This automation's inherited tool cap predates final configured-MCP capture, so it continues with its stored finite tools and may omit MCP capabilities. Reauthorize in place with an exact explicit cap: openclaw automations edit ${params.jobId} --tools <tool,...>.`,
        { severity: "warn" },
      );
    }
    return undefined;
  }
  if (!toolsAllowRequestsWebSearch(toolsAllow)) {
    return undefined;
  }
  try {
    const { shouldSuppressManagedWebSearchTool } = await loadCodexNativeWebSearch();
    if (
      shouldSuppressManagedWebSearchTool({
        config: params.cfg,
        modelProvider: params.provider,
        modelApi: params.modelApi,
        modelId: params.model,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentDir: params.agentDir,
      })
    ) {
      return undefined;
    }
    const { resolveWebSearchToolRuntimeContext } = await webToolRuntimeContextLoader.load();
    const { config, preferRuntimeProviders, runtimeWebSearch } = resolveWebSearchToolRuntimeContext(
      {
        config: params.cfg,
        lateBindRuntimeConfig: true,
      },
    );
    const { hasUsableWebSearchProvider } = await webSearchRuntimeLoader.load();
    const hasWebSearchProvider = hasUsableWebSearchProvider({
      config,
      agentDir: params.agentDir,
      runtimeWebSearch,
      preferRuntimeProviders,
    });
    return createCronRunDiagnosticsFromMissingWebSearchProvider({
      toolsAllow,
      hasWebSearchProvider,
    });
  } catch (error) {
    logWarn(
      `[cron:${params.jobId}] Failed to inspect web_search provider state for toolsAllow diagnostics: ${String(error)}`,
    );
    return undefined;
  }
}

/** Resolves the delivery plan and concrete target for one isolated cron run. */
export async function resolveCronDeliveryContext(params: {
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
      sourceDelivery: resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
    };
  }
  if (deliveryPlan.mode === "none" && !hasExplicitCronDeliveryTarget(deliveryPlan)) {
    const resolvedDelivery = {
      ok: false as const,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit" as const,
      error: new Error("delivery is disabled"),
    };
    return {
      deliveryPlan,
      deliveryRequested: false,
      resolvedDelivery,
      sourceDelivery: resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
    };
  }
  const { resolveDeliveryTarget } = await loadCronDeliveryRuntime();
  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    threadId: deliveryPlan.threadId,
    accountId: deliveryPlan.accountId,
    // Resolve the job's own session identity (sessionTarget takes precedence over sessionKey, the
    // same as delivery preview) so a session-scoped cron is not misread as keyless by the #91613
    // keyless-inherited refusal inside resolveDeliveryTarget. The refusal itself now lives in the
    // resolver (returns ok:false), so the delivery dispatch !ok gate, the failure-notification
    // path, and the delivery preview all honor it uniformly (the dispatch gate refuses the send and
    // never enqueues, so a restart has nothing to replay; the agent turn still runs before that).
    sessionKey: resolveCronDeliverySessionKey(params.job),
  });
  return {
    deliveryPlan,
    deliveryRequested: deliveryPlan.requested,
    resolvedDelivery,
    sourceDelivery: resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
  };
}

export function appendCronDeliveryInstruction(params: {
  commandBody: string;
  deliveryRequested: boolean;
  messageToolEnabled: boolean;
  resolvedDeliveryOk: boolean;
  requireExplicitMessageTarget: boolean;
}) {
  if (!params.deliveryRequested) {
    return params.commandBody;
  }
  if (params.messageToolEnabled) {
    const targetHint =
      params.requireExplicitMessageTarget || !params.resolvedDeliveryOk
        ? "with an explicit target"
        : "for the current chat";
    return `${params.commandBody}\n\nUse the message tool if you need to notify the user directly ${targetHint}. If you do not send directly, your final plain-text reply will be delivered automatically.`.trim();
  }
  return `${params.commandBody}\n\nYour response will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
}

// Static per job class on purpose: the free-form job name must not be promoted
// into the trusted suffix past the external-content fence, and byte-identical
// suffixes keep prompt caching effective. External-hook runs get only the
// common core: deferring to "the job's instructions" or advertising job
// removal would hand fenced webhook content an override lever or a
// destructive action inside the trusted suffix.
