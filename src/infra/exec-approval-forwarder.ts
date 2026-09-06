import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalAdapter,
} from "../channels/plugins/index.js";
import { getRuntimeConfig } from "../config/config.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createPendingApprovalRegistry } from "../shared/pending-approval-registry.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import {
  buildForwardedExecApprovalExpired,
  buildForwardedExecPendingPayload,
  buildForwardedExecResolvedPayload,
  buildForwardedPluginPendingPayload,
  buildForwardedPluginResolvedPayload,
} from "./exec-approval-forwarder.messages.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import {
  buildPluginApprovalExpiredMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "./plugin-approvals.js";

// Approval forwarding mirrors foreground exec/plugin approvals into configured
// chat targets, then sends resolution/expiry notices to the same targets.
const log = createSubsystemLogger("gateway/exec-approvals");
type DeliverApprovalPayloads =
  typeof import("../channels/message/runtime.js").sendDurableMessageBatchCore;
type MaybePromise<T> = T | Promise<T>;
type ResolveSessionTargetFn = (params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}) => MaybePromise<ExecApprovalForwardTarget | null>;

type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

type ApprovalRouteRequest = {
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

type PendingApproval = {
  routeRequest: ApprovalRouteRequest;
  targets: ForwardTarget[];
};

type ApprovalRenderContext = {
  cfg: OpenClawConfig;
  target: ForwardTarget;
};

type ApprovalStrategy<TRequest, TResolved> = {
  kind: ChannelApprovalKind;
  config: (cfg: OpenClawConfig) => ExecApprovalForwardingConfig | undefined;
  buildExpiredText: (request: TRequest) => string;
  buildPendingPayload: (
    params: ApprovalRenderContext & { request: TRequest; nowMs: number },
  ) => ReplyPayload;
  buildResolvedPayload: (params: ApprovalRenderContext & { resolved: TResolved }) => ReplyPayload;
};

export type ExecApprovalForwarder = {
  handleRequested: (request: ExecApprovalRequest) => Promise<boolean>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
  handlePluginApprovalRequested?: (request: PluginApprovalRequest) => Promise<boolean>;
  handlePluginApprovalResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
  stop: () => Promise<void>;
};

type ExecApprovalForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: DeliverApprovalPayloads;
  nowMs?: () => number;
  resolveSessionTarget?: ResolveSessionTargetFn;
};

const SYNTHETIC_APPROVAL_REQUEST_ID = "__approval-routing__";

const loadExecApprovalForwarderRuntime = createLazyRuntimeModule(
  () => import("./exec-approval-forwarder.runtime.js"),
);

function shouldForwardRoute(params: {
  config?: {
    enabled?: boolean;
    agentFilter?: string[];
    sessionFilter?: string[];
  };
  routeRequest: ApprovalRouteRequest;
}): boolean {
  const config = params.config;
  if (!config?.enabled) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.routeRequest,
    agentFilter: config.agentFilter,
    sessionFilter: config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

function buildTargetKey(target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  return channelRouteDedupeKey({
    channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  });
}

function buildSyntheticApprovalRequest(routeRequest: ApprovalRouteRequest): ExecApprovalRequest {
  return {
    approvalKind: "exec",
    id: SYNTHETIC_APPROVAL_REQUEST_ID,
    request: {
      command: "",
      agentId: routeRequest.agentId ?? null,
      sessionKey: routeRequest.sessionKey ?? null,
      turnSourceChannel: routeRequest.turnSourceChannel ?? null,
      turnSourceTo: routeRequest.turnSourceTo ?? null,
      turnSourceAccountId: routeRequest.turnSourceAccountId ?? null,
      turnSourceThreadId: routeRequest.turnSourceThreadId ?? null,
    },
    createdAtMs: 0,
    expiresAtMs: 0,
  };
}

function shouldSkipForwardingFallback(params: {
  approvalKind: ChannelApprovalKind;
  target: ExecApprovalForwardTarget;
  cfg: OpenClawConfig;
  routeRequest: ApprovalRouteRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (!channel) {
    return false;
  }
  // Channel adapters can suppress generic fallback delivery when they already
  // own native approval UX for the same target.
  const adapter = resolveChannelApprovalAdapter(getLoadedChannelPlugin(channel));
  return (
    adapter?.delivery?.shouldSuppressForwardingFallback?.({
      cfg: params.cfg,
      approvalKind: params.approvalKind,
      target: params.target,
      request: buildSyntheticApprovalRequest(params.routeRequest),
    }) ?? false
  );
}

function normalizeTurnSourceChannel(value?: string | null): string | undefined {
  const normalized = value ? normalizeMessageChannel(value) : undefined;
  if (
    !normalized ||
    (!isDeliverableMessageChannel(normalized) && normalized !== "webchat" && normalized !== "tui")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeForwardingTurnSourceChannel(
  value: string | null | undefined,
  approvalKind: ChannelApprovalKind,
): string | undefined {
  const normalized = normalizeTurnSourceChannel(value);
  if (approvalKind === "exec" && normalized && !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function extractApprovalRouteRequest(
  request: ApprovalRouteRequest | null | undefined,
): ApprovalRouteRequest | null {
  if (!request) {
    return null;
  }
  return {
    agentId: request.agentId ?? null,
    sessionKey: request.sessionKey ?? null,
    turnSourceChannel: request.turnSourceChannel ?? null,
    turnSourceTo: request.turnSourceTo ?? null,
    turnSourceAccountId: request.turnSourceAccountId ?? null,
    turnSourceThreadId: request.turnSourceThreadId ?? null,
  };
}

function defaultResolveSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): Promise<ExecApprovalForwardTarget | null> {
  return loadExecApprovalForwarderRuntime().then(({ resolveExecApprovalSessionTarget }) => {
    const resolvedTarget = resolveExecApprovalSessionTarget({
      cfg: params.cfg,
      request: params.request,
      turnSourceChannel: normalizeTurnSourceChannel(params.request.request.turnSourceChannel),
      turnSourceTo: normalizeOptionalString(params.request.request.turnSourceTo),
      turnSourceAccountId: normalizeOptionalString(params.request.request.turnSourceAccountId),
      turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
    });
    if (!resolvedTarget?.channel || !resolvedTarget.to) {
      return null;
    }
    const channel = resolvedTarget.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return null;
    }
    return {
      channel,
      to: resolvedTarget.to,
      accountId: resolvedTarget.accountId,
      threadId: resolvedTarget.threadId,
    };
  });
}

async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: ForwardTarget[];
  buildPayload: (target: ForwardTarget) => ReplyPayload;
  deliver: DeliverApprovalPayloads;
  beforeDeliver?: (target: ForwardTarget, payload: ReplyPayload) => Promise<void> | void;
  shouldSend?: () => boolean;
}) {
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    try {
      const payload = params.buildPayload(target);
      await params.beforeDeliver?.(target, payload);
      const send = await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [payload],
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
    } catch (err) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
}

async function resolveForwardTargets(params: {
  cfg: OpenClawConfig;
  config?: ExecApprovalForwardingConfig;
  approvalKind: ChannelApprovalKind;
  routeRequest: ApprovalRouteRequest;
  resolveSessionTarget: ResolveSessionTargetFn;
}): Promise<ForwardTarget[]> {
  const mode = params.config?.mode ?? "session";
  const targets: ForwardTarget[] = [];
  const seen = new Set<string>();

  if (mode === "session" || mode === "both") {
    const sessionRouteRequest = {
      ...params.routeRequest,
      turnSourceChannel: normalizeForwardingTurnSourceChannel(
        params.routeRequest.turnSourceChannel,
        params.approvalKind,
      ),
    };
    const sessionTarget = await params.resolveSessionTarget({
      cfg: params.cfg,
      request: buildSyntheticApprovalRequest(sessionRouteRequest),
    });
    if (sessionTarget) {
      const key = buildTargetKey(sessionTarget);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ ...sessionTarget, source: "session" });
      }
    }
  }

  if (mode === "targets" || mode === "both") {
    const explicitTargets = params.config?.targets ?? [];
    for (const target of explicitTargets) {
      const key = buildTargetKey(target);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({ ...target, source: "target" });
    }
  }

  return targets;
}

function createApprovalHandlers<
  TRequest extends { id: string; request: ApprovalRouteRequest; expiresAtMs: number },
  TResolved extends { id: string; request?: ApprovalRouteRequest | null },
>(params: {
  strategy: ApprovalStrategy<TRequest, TResolved>;
  getConfig: () => OpenClawConfig;
  deliver: DeliverApprovalPayloads;
  nowMs: () => number;
  resolveSessionTarget: ResolveSessionTargetFn;
}) {
  const pending = createPendingApprovalRegistry<PendingApproval>();
  const work = new AsyncWorkScope();
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const trackDelivery = <T>(run: () => Promise<T>) =>
    work.track(() => runWithRetainedGatewayRootWork(run));

  const resolveTargets = async (paramsForRoute: {
    cfg: OpenClawConfig;
    config?: ExecApprovalForwardingConfig;
    routeRequest: ApprovalRouteRequest;
  }): Promise<ForwardTarget[]> => {
    if (!shouldForwardRoute(paramsForRoute)) {
      return [];
    }
    const targets = await resolveForwardTargets({
      ...paramsForRoute,
      approvalKind: params.strategy.kind,
      resolveSessionTarget: params.resolveSessionTarget,
    });
    return targets.filter(
      (target) =>
        !shouldSkipForwardingFallback({
          approvalKind: params.strategy.kind,
          target,
          cfg: paramsForRoute.cfg,
          routeRequest: paramsForRoute.routeRequest,
        }),
    );
  };

  const deliverResolved = async (resolved: TResolved, entry?: PendingApproval): Promise<void> => {
    const cfg = params.getConfig();
    const routeRequest = entry?.routeRequest ?? extractApprovalRouteRequest(resolved.request);
    const targets =
      entry?.targets ??
      (routeRequest
        ? await resolveTargets({
            cfg,
            config: params.strategy.config(cfg),
            routeRequest,
          })
        : []);
    if (!targets.length) {
      return;
    }
    await deliverToTargets({
      cfg,
      targets,
      buildPayload: (target) =>
        params.strategy.buildResolvedPayload({
          cfg,
          resolved,
          target,
        }),
      deliver: params.deliver,
    });
  };

  const handleRequested = async (request: TRequest): Promise<boolean> => {
    const cfg = params.getConfig();
    const config = params.strategy.config(cfg);
    const requestId = request.id;
    const routeRequest = extractApprovalRouteRequest(request.request) ?? {};
    // Register before route lookup so a fast resolution cannot overtake and resurrect delivery.
    const pendingEntry = pending.begin(requestId, { routeRequest, targets: [] });
    let filteredTargets: ForwardTarget[];
    try {
      filteredTargets = await resolveTargets({ cfg, config, routeRequest });
    } catch (error) {
      pending.remove(requestId, pendingEntry);
      throw error;
    }
    if (filteredTargets.length === 0) {
      pending.remove(requestId, pendingEntry);
      return false;
    }

    pendingEntry.value = { routeRequest, targets: filteredTargets };
    const expiresInMs = Math.max(0, request.expiresAtMs - params.nowMs());
    pending.scheduleExpiry(pendingEntry, expiresInMs, (expired) =>
      trackDelivery(() =>
        deliverToTargets({
          cfg,
          targets: expired.value.targets,
          buildPayload: () => ({ text: params.strategy.buildExpiredText(request) }),
          deliver: params.deliver,
        }),
      ).catch((err: unknown) => {
        log.error(
          `${params.strategy.kind} approvals: failed to deliver expiry notification for ${requestId}: ${String(err)}`,
        );
      }),
    );

    void trackDelivery(() =>
      deliverToTargets({
        cfg,
        targets: filteredTargets,
        buildPayload: (target) =>
          params.strategy.buildPendingPayload({
            cfg,
            request,
            target,
            nowMs: params.nowMs(),
          }),
        beforeDeliver: async (target, payload) => {
          const channel = normalizeMessageChannel(target.channel) ?? target.channel;
          if (!channel) {
            return;
          }
          await getLoadedChannelPlugin(channel)?.outbound?.beforeDeliverPayload?.({
            cfg,
            target,
            payload,
            hint: {
              kind: "approval-pending",
              approvalKind: params.strategy.kind,
            },
          });
        },
        deliver: params.deliver,
        shouldSend: () => pending.isCurrent(pendingEntry),
      }).then(() => pending.completeDelivery(pendingEntry, pendingEntry.value)),
    ).catch((err: unknown) => {
      log.error(
        `${params.strategy.kind} approvals: failed to deliver request ${requestId}: ${String(err)}`,
      );
    });
    return true;
  };

  const handleResolved = async (resolved: TResolved) => {
    const settled = pending.settle(resolved.id, (entry) => deliverResolved(resolved, entry.value));
    if (settled.status === "queued") {
      return;
    }
    if (settled.status === "taken") {
      await settled.terminal(settled.entry);
      return;
    }
    await deliverResolved(resolved);
  };

  return {
    handleRequested: (request: TRequest) =>
      stopped ? Promise.resolve(false) : trackDelivery(() => handleRequested(request)),
    handleResolved: (resolved: TResolved) =>
      stopped ? Promise.resolve() : trackDelivery(() => handleResolved(resolved)),
    stop: () => {
      if (!stopPromise) {
        stopped = true;
        // Stop future expiry, but retain a genuine terminal queued behind an active delivery.
        pending.stopExpiryTimers();
        stopPromise = work.drain().then(() => pending.clear());
      }
      return stopPromise;
    },
  };
}

const execApprovalStrategy = {
  kind: "exec",
  config: (cfg) => cfg.approvals?.exec,
  buildExpiredText: buildForwardedExecApprovalExpired,
  buildPendingPayload: buildForwardedExecPendingPayload,
  buildResolvedPayload: buildForwardedExecResolvedPayload,
} satisfies ApprovalStrategy<ExecApprovalRequest, ExecApprovalResolved>;

const pluginApprovalStrategy = {
  kind: "plugin",
  config: (cfg) => cfg.approvals?.plugin,
  buildExpiredText: buildPluginApprovalExpiredMessage,
  buildPendingPayload: buildForwardedPluginPendingPayload,
  buildResolvedPayload: buildForwardedPluginResolvedPayload,
} satisfies ApprovalStrategy<PluginApprovalRequest, PluginApprovalResolved>;

export function createExecApprovalForwarder(
  deps: ExecApprovalForwarderDeps = {},
): ExecApprovalForwarder {
  const getConfig = deps.getConfig ?? getRuntimeConfig;
  const deliver =
    deps.deliver ??
    (async (params) => {
      const { sendDurableMessageBatchCore } = await loadExecApprovalForwarderRuntime();
      return sendDurableMessageBatchCore(params);
    });
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;

  const execHandlers = createApprovalHandlers({
    strategy: execApprovalStrategy,
    getConfig,
    deliver,
    nowMs,
    resolveSessionTarget,
  });
  const pluginHandlers = createApprovalHandlers({
    strategy: pluginApprovalStrategy,
    getConfig,
    deliver,
    nowMs,
    resolveSessionTarget,
  });

  return {
    handleRequested: execHandlers.handleRequested,
    handleResolved: execHandlers.handleResolved,
    handlePluginApprovalRequested: pluginHandlers.handleRequested,
    handlePluginApprovalResolved: pluginHandlers.handleResolved,
    stop: async () => {
      await Promise.all([execHandlers.stop(), pluginHandlers.stop()]);
    },
  };
}
