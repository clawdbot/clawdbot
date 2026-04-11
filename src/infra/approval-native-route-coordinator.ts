import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type {
  ChannelApprovalNativeDeliveryPlan,
  ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import {
  describeApprovalDeliveryDestination,
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

const activeApprovalRouteRuntimes = new Map<string, ApprovalRouteRuntimeRecord>();
const pendingApprovalRouteNotices = new Map<string, PendingApprovalRouteNotice>();
let approvalRouteRuntimeSeq = 0;
const MAX_APPROVAL_ROUTE_NOTICE_TTL_MS = 5 * 60_000;

function normalizeChannel(value?: string | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function clearPendingApprovalRouteNotice(approvalId: string): void {
  const entry = pendingApprovalRouteNotices.get(approvalId);
  if (!entry) {
    return;
  }
  pendingApprovalRouteNotices.delete(approvalId);
  if (entry.cleanupTimeout) {
    clearTimeout(entry.cleanupTimeout);
  }
}

function createPendingApprovalRouteNotice(params: {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  expectedRuntimeIds?: Iterable<string>;
}): PendingApprovalRouteNotice {
  const timeoutMs = Math.min(
    Math.max(0, params.request.expiresAtMs - Date.now()),
    MAX_APPROVAL_ROUTE_NOTICE_TTL_MS,
  );
  const cleanupTimeout = setTimeout(() => {
    clearPendingApprovalRouteNotice(params.request.id);
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

function resolveApprovalRouteNotice(params: {
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
    params.reports.find((report) => activeApprovalRouteRuntimes.has(report.runtimeId))
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

async function maybeFinalizeApprovalRouteNotice(approvalId: string): Promise<void> {
  const entry = pendingApprovalRouteNotices.get(approvalId);
  if (!entry || entry.finalized) {
    return;
  }
  for (const runtimeId of entry.expectedRuntimeIds) {
    if (!entry.reports.has(runtimeId)) {
      return;
    }
  }

  entry.finalized = true;
  const reports = Array.from(entry.reports.values());
  const notice = resolveApprovalRouteNotice({
    request: entry.request,
    reports,
  });
  clearPendingApprovalRouteNotice(approvalId);
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

export function createApprovalNativeRouteReporter(params: {
  handledKinds: ReadonlySet<ChannelApprovalKind>;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  requestGateway: GatewayRequestFn;
}) {
  const runtimeId = `native-approval-route:${++approvalRouteRuntimeSeq}`;
  let registered = false;

  const report = async (payload: {
    approvalKind: ChannelApprovalKind;
    request: ApprovalRequest;
    deliveryPlan: ChannelApprovalNativeDeliveryPlan;
    deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  }): Promise<void> => {
    if (!registered || !params.handledKinds.has(payload.approvalKind)) {
      return;
    }
    const entry =
      pendingApprovalRouteNotices.get(payload.request.id) ??
      createPendingApprovalRouteNotice({
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
    pendingApprovalRouteNotices.set(payload.request.id, entry);
    await maybeFinalizeApprovalRouteNotice(payload.request.id);
  };

  return {
    observeRequest(payload: { approvalKind: ChannelApprovalKind; request: ApprovalRequest }): void {
      if (!registered || !params.handledKinds.has(payload.approvalKind)) {
        return;
      }
      const entry =
        pendingApprovalRouteNotices.get(payload.request.id) ??
        createPendingApprovalRouteNotice({
          request: payload.request,
          approvalKind: payload.approvalKind,
          expectedRuntimeIds: Array.from(activeApprovalRouteRuntimes.values())
            .filter((runtime) => runtime.handledKinds.has(payload.approvalKind))
            .map((runtime) => runtime.runtimeId),
        });
      entry.expectedRuntimeIds.add(runtimeId);
      pendingApprovalRouteNotices.set(payload.request.id, entry);
    },
    start(): void {
      if (registered) {
        return;
      }
      activeApprovalRouteRuntimes.set(runtimeId, {
        runtimeId,
        handledKinds: params.handledKinds,
        channel: params.channel,
        channelLabel: params.channelLabel,
        accountId: params.accountId,
        requestGateway: params.requestGateway,
      });
      registered = true;
    },
    async reportSkipped(params: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
    }): Promise<void> {
      await report({
        approvalKind: params.approvalKind,
        request: params.request,
        deliveryPlan: {
          targets: [],
          originTarget: null,
          notifyOriginWhenDmOnly: false,
        },
        deliveredTargets: [],
      });
    },
    async reportDelivery(params: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
      deliveryPlan: ChannelApprovalNativeDeliveryPlan;
      deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
    }): Promise<void> {
      await report(params);
    },
    async stop(): Promise<void> {
      if (!registered) {
        return;
      }
      registered = false;
      activeApprovalRouteRuntimes.delete(runtimeId);
      for (const entry of pendingApprovalRouteNotices.values()) {
        entry.expectedRuntimeIds.delete(runtimeId);
        if (entry.expectedRuntimeIds.size === 0) {
          clearPendingApprovalRouteNotice(entry.request.id);
          continue;
        }
        await maybeFinalizeApprovalRouteNotice(entry.request.id);
      }
    },
  };
}

export function clearApprovalNativeRouteStateForTest(): void {
  for (const approvalId of Array.from(pendingApprovalRouteNotices.keys())) {
    clearPendingApprovalRouteNotice(approvalId);
  }
  activeApprovalRouteRuntimes.clear();
  approvalRouteRuntimeSeq = 0;
}
