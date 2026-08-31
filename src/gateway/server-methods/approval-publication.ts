import type { ChannelApprovalKind } from "../../infra/approval-types.js";
// Best-effort legacy approval resolution events after durable CAS wins.
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
import { broadcastApprovalResolvedEvent } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

type ApprovalRequest =
  | ExecApprovalRequestPayload
  | PluginApprovalRequestPayload
  | SystemAgentApprovalRequestPayload;

export type ExecApprovalIosPushDelivery = {
  handleResolved?: (resolved: ExecApprovalResolved) => Promise<void>;
};

export type PluginApprovalIosPushDelivery = {
  handleResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
};

async function runSideEffect(params: {
  context: GatewayRequestContext;
  approvalKind: "exec" | "plugin" | "system-agent";
  effect: "broadcast" | "forwarder" | "ios-push" | "web-push";
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
  approvalKind: ChannelApprovalKind;
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
  const event = {
    id: params.record.id,
    decision,
    resolvedBy,
    ts,
    request: params.liveRecord.request,
  };
  await runSideEffect({
    context: params.context,
    approvalKind: params.record.kind,
    effect: "broadcast",
    run: () =>
      broadcastApprovalResolvedEvent({
        approvalKind: params.record.kind,
        context: params.context,
        event,
        record: params.liveRecord,
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
    const webPushDelivery = params.context.approvalWebPushDelivery;
    if (webPushDelivery) {
      await runSideEffect({
        context: params.context,
        approvalKind: nativeApprovalKind,
        effect: "web-push",
        run: () =>
          params.record.status === "expired"
            ? webPushDelivery.handleExpired(params.liveRecord)
            : webPushDelivery.handleResolved(event),
      });
    }
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
