import { expectDefined } from "@openclaw/normalization-core";
// Coordinates native approval delivery routing and notices.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelApprovalNativeDeliveryPlan,
  ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import {
  describeApprovalDeliveryDestination,
  resolveApprovalDeliveryFailedNoticeText,
  resolveApprovalRoutedElsewhereNoticeText,
} from "./approval-native-route-notice.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type GatewayRequestFn = <T = unknown>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

type ApprovalRouteRuntimeRecord = {
  runtimeId: string;
  handledKinds: ReadonlySet<ChannelApprovalKind>;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  requestGateway: GatewayRequestFn;
};

type ApprovalRouteReport = {
  runtimeId: string;
  request: ApprovalRequest;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  deliveryPlan: ChannelApprovalNativeDeliveryPlan;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  requestGateway: GatewayRequestFn;
};

type PendingApprovalRouteNotice = {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  expectedRuntimeIds: Set<string>;
  reports: Map<string, ApprovalRouteReport>;
  cleanupTimeout: NodeJS.Timeout | null;
  finalized: boolean;
};

type RouteNoticeTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

type ApprovalNativeRouteCoordinatorState = {
  activeRuntimes: Map<string, ApprovalRouteRuntimeRecord>;
  pendingNotices: Map<string, PendingApprovalRouteNotice>;
  runtimeSeq: number;
  closed: boolean;
};

function createApprovalNativeRouteCoordinatorState(): ApprovalNativeRouteCoordinatorState {
  return {
    activeRuntimes: new Map(),
    pendingNotices: new Map(),
    runtimeSeq: 0,
    closed: false,
  };
}

const defaultCoordinatorState = createApprovalNativeRouteCoordinatorState();
const MAX_APPROVAL_ROUTE_NOTICE_TTL_MS = 5 * 60_000;

function normalizeChannel(value?: string | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function clearPendingApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const entry = state.pendingNotices.get(approvalId);
  if (!entry) {
    return;
  }
  state.pendingNotices.delete(approvalId);
  if (entry.cleanupTimeout) {
    clearTimeout(entry.cleanupTimeout);
  }
}

function createPendingApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  params: {
    request: ApprovalRequest;
    approvalKind: ChannelApprovalKind;
    expectedRuntimeIds?: Iterable<string>;
  },
): PendingApprovalRouteNotice {
  const timeoutMs = Math.min(
    Math.max(0, params.request.expiresAtMs - Date.now()),
    MAX_APPROVAL_ROUTE_NOTICE_TTL_MS,
  );
  const cleanupTimeout = setTimeout(() => {
    clearPendingApprovalRouteNotice(state, params.request.id);
  }, timeoutMs);
  cleanupTimeout.unref?.();
  return {
    request: params.request,
    approvalKind: params.approvalKind,
    // Snapshot siblings at first observation time so already-running runtimes
    // can still aggregate one notice, while late-starting runtimes that cannot
    // replay old gateway events never block the quorum.
    expectedRuntimeIds: new Set(params.expectedRuntimeIds ?? []),
    reports: new Map(),
    cleanupTimeout,
    finalized: false,
  };
}

function resolveRouteNoticeTargetFromRequest(request: ApprovalRequest): RouteNoticeTarget | null {
  const channel = request.request.turnSourceChannel?.trim();
  const to = request.request.turnSourceTo?.trim();
  if (!channel || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: request.request.turnSourceAccountId ?? undefined,
    threadId: request.request.turnSourceThreadId ?? undefined,
  };
}

function resolveFallbackRouteNoticeTarget(report: ApprovalRouteReport): RouteNoticeTarget | null {
  const channel = report.channel?.trim();
  const to = report.deliveryPlan.originTarget?.to?.trim();
  if (!channel || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: report.accountId ?? undefined,
    threadId: report.deliveryPlan.originTarget?.threadId ?? undefined,
  };
}

function didReportDeliverToOrigin(report: ApprovalRouteReport, originAccountId?: string): boolean {
  const originTarget = report.deliveryPlan.originTarget;
  if (!originTarget) {
    return false;
  }
  const reportAccountId = normalizeOptionalString(report.accountId);
  if (
    originAccountId !== undefined &&
    reportAccountId !== undefined &&
    reportAccountId !== originAccountId
  ) {
    return false;
  }
  const originKey = buildChannelApprovalNativeTargetKey(originTarget);
  return report.deliveredTargets.some(
    (plannedTarget) => buildChannelApprovalNativeTargetKey(plannedTarget.target) === originKey,
  );
}

function hasPlannedNativeTargets(report: ApprovalRouteReport): boolean {
  return report.deliveryPlan.targets.length > 0;
}

function readAllowedDecisionStrings(request: ApprovalRequest): string[] | undefined {
  const allowedDecisions =
    "allowedDecisions" in request.request ? request.request.allowedDecisions : undefined;
  if (!Array.isArray(allowedDecisions)) {
    return undefined;
  }
  return allowedDecisions.filter((value): value is string => typeof value === "string");
}

function resolveApprovalRouteNotice(params: {
  state: ApprovalNativeRouteCoordinatorState;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
  reports: readonly ApprovalRouteReport[];
}): { requestGateway: GatewayRequestFn; target: RouteNoticeTarget; text: string } | null {
  const explicitTarget = resolveRouteNoticeTargetFromRequest(params.request);
  const originChannel = normalizeChannel(
    explicitTarget?.channel ?? params.request.request.turnSourceChannel,
  );
  const fallbackTarget =
    params.reports
      .filter((report) => normalizeChannel(report.channel) === originChannel || !originChannel)
      .map(resolveFallbackRouteNoticeTarget)
      .find((target) => target !== null) ?? null;
  const target = explicitTarget
    ? {
        ...fallbackTarget,
        ...explicitTarget,
        accountId: explicitTarget.accountId ?? fallbackTarget?.accountId,
        threadId: explicitTarget.threadId ?? fallbackTarget?.threadId,
      }
    : fallbackTarget;
  if (!target) {
    return null;
  }
  const originAccountId = normalizeOptionalString(target.accountId);
  const deliveredAnyTarget = params.reports.some((report) => report.deliveredTargets.length > 0);
  if (!deliveredAnyTarget && params.reports.some(hasPlannedNativeTargets)) {
    return {
      requestGateway:
        params.reports.find((report) => params.state.activeRuntimes.has(report.runtimeId))
          ?.requestGateway ?? expectDefined(params.reports[0], "reports entry at 0").requestGateway,
      target,
      text: resolveApprovalDeliveryFailedNoticeText({
        approvalId: params.request.id,
        approvalKind: params.approvalKind,
        allowedDecisions: readAllowedDecisionStrings(params.request),
      }),
    };
  }

  // If any same-channel runtime already delivered into the origin chat, every
  // other fallback delivery becomes supplemental and should not trigger a notice.
  const originDelivered = params.reports.some((report) => {
    if (originChannel && normalizeChannel(report.channel) !== originChannel) {
      return false;
    }
    return didReportDeliverToOrigin(report, originAccountId);
  });
  if (originDelivered) {
    return null;
  }

  const destinations = params.reports.flatMap((report) => {
    if (!report.channelLabel || report.deliveredTargets.length === 0) {
      return [];
    }
    const reportChannel = normalizeChannel(report.channel);
    if (
      originChannel &&
      reportChannel === originChannel &&
      !report.deliveryPlan.notifyOriginWhenDmOnly
    ) {
      return [];
    }
    const reportAccountId = normalizeOptionalString(report.accountId);
    if (
      originChannel &&
      reportChannel === originChannel &&
      originAccountId !== undefined &&
      reportAccountId !== undefined &&
      reportAccountId !== originAccountId
    ) {
      return [];
    }
    return [
      describeApprovalDeliveryDestination({
        channelLabel: report.channelLabel,
        deliveredTargets: report.deliveredTargets,
      }),
    ];
  });
  const text = resolveApprovalRoutedElsewhereNoticeText(destinations);
  if (!text) {
    return null;
  }

  const requestGateway =
    params.reports.find((report) => params.state.activeRuntimes.has(report.runtimeId))
      ?.requestGateway ?? params.reports[0]?.requestGateway;
  if (!requestGateway) {
    return null;
  }

  return {
    requestGateway,
    target,
    text,
  };
}

/** Returns whether a native approval runtime is active for the requested channel/account scope. */
export function hasActiveApprovalNativeRouteRuntime(params: {
  approvalKind: ChannelApprovalKind;
  channel?: string | null;
  accountId?: string | null;
}): boolean {
  return hasActiveApprovalNativeRouteRuntimeForState(defaultCoordinatorState, params);
}

function hasActiveApprovalNativeRouteRuntimeForState(
  state: ApprovalNativeRouteCoordinatorState,
  params: {
    approvalKind: ChannelApprovalKind;
    channel?: string | null;
    accountId?: string | null;
  },
): boolean {
  const channel = normalizeChannel(params.channel);
  const accountId = normalizeOptionalString(params.accountId);
  return Array.from(state.activeRuntimes.values()).some((runtime) => {
    if (!runtime.handledKinds.has(params.approvalKind)) {
      return false;
    }
    if (channel && normalizeChannel(runtime.channel) !== channel) {
      return false;
    }
    const runtimeAccountId = normalizeOptionalString(runtime.accountId);
    return (
      accountId === undefined || runtimeAccountId === undefined || runtimeAccountId === accountId
    );
  });
}

async function maybeFinalizeApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): Promise<void> {
  const entry = state.pendingNotices.get(approvalId);
  if (!entry || entry.finalized) {
    return;
  }
  for (const runtimeId of entry.expectedRuntimeIds) {
    if (!entry.reports.has(runtimeId)) {
      return;
    }
  }

  entry.finalized = true;
  // Only runtimes observed with the request can block finalization; later runtimes must not delay it.
  const reports = Array.from(entry.reports.values());
  const notice = resolveApprovalRouteNotice({
    state,
    approvalKind: entry.approvalKind,
    request: entry.request,
    reports,
  });
  clearPendingApprovalRouteNotice(state, approvalId);
  if (!notice) {
    return;
  }

  try {
    await notice.requestGateway("send", {
      channel: notice.target.channel,
      to: notice.target.to,
      accountId: notice.target.accountId ?? undefined,
      threadId: notice.target.threadId ?? undefined,
      message: notice.text,
      idempotencyKey: `approval-route-notice:${approvalId}`,
    });
  } catch {
    // The approval delivery already succeeded; the follow-up notice is best-effort.
  }
}

/** Tracks native approval deliveries and sends origin-chat notices after all observed runtimes report. */
export function createApprovalNativeRouteReporter(params: {
  handledKinds: ReadonlySet<ChannelApprovalKind>;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  requestGateway: GatewayRequestFn;
}) {
  return createApprovalNativeRouteReporterForState(defaultCoordinatorState, params);
}

function createApprovalNativeRouteReporterForState(
  state: ApprovalNativeRouteCoordinatorState,
  params: {
    handledKinds: ReadonlySet<ChannelApprovalKind>;
    channel?: string;
    channelLabel?: string;
    accountId?: string | null;
    requestGateway: GatewayRequestFn;
  },
) {
  const runtimeId = `native-approval-route:${++state.runtimeSeq}`;
  let registered = false;

  const report = async (payload: {
    approvalKind: ChannelApprovalKind;
    request: ApprovalRequest;
    deliveryPlan: ChannelApprovalNativeDeliveryPlan;
    deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  }): Promise<void> => {
    if (state.closed || !registered || !params.handledKinds.has(payload.approvalKind)) {
      return;
    }
    const entry =
      state.pendingNotices.get(payload.request.id) ??
      createPendingApprovalRouteNotice(state, {
        request: payload.request,
        approvalKind: payload.approvalKind,
        expectedRuntimeIds: [runtimeId],
      });
    entry.expectedRuntimeIds.add(runtimeId);
    entry.reports.set(runtimeId, {
      runtimeId,
      request: payload.request,
      channel: params.channel,
      channelLabel: params.channelLabel,
      accountId: params.accountId,
      deliveryPlan: payload.deliveryPlan,
      deliveredTargets: payload.deliveredTargets,
      requestGateway: params.requestGateway,
    });
    state.pendingNotices.set(payload.request.id, entry);
    await maybeFinalizeApprovalRouteNotice(state, payload.request.id);
  };

  return {
    observeRequest(payload: { approvalKind: ChannelApprovalKind; request: ApprovalRequest }): void {
      if (state.closed || !registered || !params.handledKinds.has(payload.approvalKind)) {
        return;
      }
      const entry =
        state.pendingNotices.get(payload.request.id) ??
        createPendingApprovalRouteNotice(state, {
          request: payload.request,
          approvalKind: payload.approvalKind,
          expectedRuntimeIds: Array.from(state.activeRuntimes.values())
            .filter((runtime) => runtime.handledKinds.has(payload.approvalKind))
            .map((runtime) => runtime.runtimeId),
        });
      entry.expectedRuntimeIds.add(runtimeId);
      state.pendingNotices.set(payload.request.id, entry);
    },
    start(): void {
      if (state.closed || registered) {
        return;
      }
      state.activeRuntimes.set(runtimeId, {
        runtimeId,
        handledKinds: params.handledKinds,
        channel: params.channel,
        channelLabel: params.channelLabel,
        accountId: params.accountId,
        requestGateway: params.requestGateway,
      });
      registered = true;
    },
    async reportSkipped(paramsValue: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
    }): Promise<void> {
      await report({
        approvalKind: paramsValue.approvalKind,
        request: paramsValue.request,
        deliveryPlan: {
          targets: [],
          originTarget: null,
          notifyOriginWhenDmOnly: false,
        },
        deliveredTargets: [],
      });
    },
    async reportDelivery(paramsLocal: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
      deliveryPlan: ChannelApprovalNativeDeliveryPlan;
      deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
    }): Promise<void> {
      await report(paramsLocal);
    },
    async stop(): Promise<void> {
      if (!registered) {
        return;
      }
      registered = false;
      state.activeRuntimes.delete(runtimeId);
      for (const entry of state.pendingNotices.values()) {
        entry.expectedRuntimeIds.delete(runtimeId);
        if (entry.expectedRuntimeIds.size === 0) {
          clearPendingApprovalRouteNotice(state, entry.request.id);
          continue;
        }
        await maybeFinalizeApprovalRouteNotice(state, entry.request.id);
      }
    },
  };
}

export type ApprovalNativeRouteCoordinator = {
  createReporter: typeof createApprovalNativeRouteReporter;
  hasActiveRuntime: typeof hasActiveApprovalNativeRouteRuntime;
  close: () => void;
};

/** Creates an instance-local route coordinator so Gateway runtimes cannot share account state. */
export function createApprovalNativeRouteCoordinator(): ApprovalNativeRouteCoordinator {
  const state = createApprovalNativeRouteCoordinatorState();
  return {
    createReporter: (params) => createApprovalNativeRouteReporterForState(state, params),
    hasActiveRuntime: (params) => hasActiveApprovalNativeRouteRuntimeForState(state, params),
    close: () => {
      // Closing retires this Gateway-owned coordinator permanently. Delayed channel
      // startup must not repopulate routes belonging to the retired instance.
      state.closed = true;
      for (const approvalId of Array.from(state.pendingNotices.keys())) {
        clearPendingApprovalRouteNotice(state, approvalId);
      }
      state.activeRuntimes.clear();
    },
  };
}
