// Best-effort legacy approval resolution events after durable CAS wins.
import type { ApprovalDecision } from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type {
  ExecApprovalRequestPayload,
  ExecApprovalResolved,
} from "../../infra/exec-approvals.js";
import type {
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.js";
import { resolveApprovalRequestRecipientConnIds } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

type ApprovalRequest =
  | ExecApprovalRequestPayload
  | PluginApprovalRequestPayload
  | SystemAgentApprovalRequestPayload;

type SystemAgentApprovalResolved = {
  id: string;
  decision: ApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request: SystemAgentApprovalRequestPayload;
};

export type ExecApprovalIosPushDelivery = {
  handleResolved?: (resolved: ExecApprovalResolved) => Promise<void>;
};

export type PluginApprovalIosPushDelivery = {
  handleResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
};

function broadcastResolvedEvent(params: {
  approvalKind: "exec" | "plugin" | "system-agent";
  context: GatewayRequestContext;
  eventName: "exec.approval.resolved" | "plugin.approval.resolved" | "openclaw.approval.resolved";
  event: ExecApprovalResolved | PluginApprovalResolved | SystemAgentApprovalResolved;
  liveRecord: ExecApprovalRecord<ApprovalRequest>;
}): void {
  const recipientConnIds = resolveApprovalRequestRecipientConnIds({
    approvalKind: params.approvalKind,
    context: params.context,
    record: {
      id: params.liveRecord.id,
      request: params.liveRecord.request,
      createdAtMs: params.liveRecord.createdAtMs,
      expiresAtMs: params.liveRecord.expiresAtMs,
      requestedByConnId: params.liveRecord.requestedByConnId,
      requestedByDeviceId: params.liveRecord.requestedByDeviceId,
      requestedByClientId: params.liveRecord.requestedByClientId,
      requestedByDeviceTokenAuth: params.liveRecord.requestedByDeviceTokenAuth,
      approvalReviewerDeviceIds: params.liveRecord.approvalReviewerDeviceIds,
    },
  });
  if (recipientConnIds) {
    params.context.broadcastToConnIds(params.eventName, params.event, recipientConnIds, {
      dropIfSlow: true,
    });
    return;
  }
  params.context.broadcast(params.eventName, params.event, { dropIfSlow: true });
}

async function runSideEffect(params: {
  context: GatewayRequestContext;
  approvalKind: "exec" | "plugin" | "system-agent";
  effect: "broadcast" | "forwarder" | "ios-push";
  run: () => void | Promise<void>;
}): Promise<void> {
  try {
    await params.run();
  } catch (error) {
    params.context.logGateway?.error?.(
      `${params.approvalKind} approvals: unified resolve ${params.effect} failed: ${String(error)}`,
    );
  }
}

function runSynchronousSideEffect(params: {
  context: GatewayRequestContext;
  approvalKind: "exec" | "plugin";
  run: () => void;
}): void {
  try {
    params.run();
  } catch (error) {
    params.context.logGateway?.error?.(
      `${params.approvalKind} approvals: unified resolve internal-subscriber failed: ${String(error)}`,
    );
  }
}

export async function publishAppliedApprovalResolution(params: {
  record: OperatorApprovalRecord;
  liveRecord: ExecApprovalRecord<ApprovalRequest>;
  context: GatewayRequestContext;
  forwarder?: ExecApprovalForwarder;
  iosPushDelivery?: ExecApprovalIosPushDelivery;
  pluginIosPushDelivery?: PluginApprovalIosPushDelivery;
}): Promise<void> {
  const decision = params.record.decision ?? "deny";
  const resolvedBy = params.liveRecord.resolvedBy ?? null;
  const ts = params.record.resolvedAtMs ?? Date.now();
  const eventName =
    params.record.kind === "exec"
      ? "exec.approval.resolved"
      : params.record.kind === "plugin"
        ? "plugin.approval.resolved"
        : "openclaw.approval.resolved";
  const event = {
    id: params.record.id,
    decision,
    resolvedBy,
    ts,
    request: params.liveRecord.request,
  } as ExecApprovalResolved | PluginApprovalResolved | SystemAgentApprovalResolved;
  await runSideEffect({
    context: params.context,
    approvalKind: params.record.kind,
    effect: "broadcast",
    run: () =>
      broadcastResolvedEvent({
        approvalKind: params.record.kind,
        context: params.context,
        eventName,
        event,
        liveRecord: params.liveRecord,
      }),
  });
  const nativeApprovalKind = params.record.kind;
  if (nativeApprovalKind === "exec" || nativeApprovalKind === "plugin") {
    // Native approval routes are instance-local, so publish the canonical CAS
    // winner directly instead of reconnecting to the Gateway over WebSocket.
    runSynchronousSideEffect({
      context: params.context,
      approvalKind: nativeApprovalKind,
      run: () => params.context.approvalEvents?.publishResolved(nativeApprovalKind, event),
    });
  }
  if (params.record.kind === "exec" && params.forwarder) {
    await runSideEffect({
      context: params.context,
      approvalKind: "exec",
      effect: "forwarder",
      run: () => params.forwarder!.handleResolved(event as ExecApprovalResolved),
    });
  }
  if (params.record.kind === "exec" && params.iosPushDelivery?.handleResolved) {
    await runSideEffect({
      context: params.context,
      approvalKind: "exec",
      effect: "ios-push",
      run: () => params.iosPushDelivery!.handleResolved!(event as ExecApprovalResolved),
    });
  }
  if (params.record.kind === "plugin" && params.forwarder?.handlePluginApprovalResolved) {
    await runSideEffect({
      context: params.context,
      approvalKind: "plugin",
      effect: "forwarder",
      run: () => params.forwarder!.handlePluginApprovalResolved!(event as PluginApprovalResolved),
    });
  }
  if (params.record.kind === "plugin" && params.pluginIosPushDelivery?.handleResolved) {
    await runSideEffect({
      context: params.context,
      approvalKind: "plugin",
      effect: "ios-push",
      run: () => params.pluginIosPushDelivery!.handleResolved!(event as PluginApprovalResolved),
    });
  }
}
