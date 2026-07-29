// Settles run-bound approvals when their active agent run is aborted.
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type { ExecApprovalIosPushDelivery } from "./approval-publication.js";
import { publishAppliedApprovalResolution } from "./approval-publication.js";
import type { GatewayRequestContext } from "./types.js";

export function cancelRunBoundExecApprovals(params: {
  runId: string;
  manager: ExecApprovalManager;
  context: GatewayRequestContext;
  forwarder?: ExecApprovalForwarder;
  iosPushDelivery?: ExecApprovalIosPushDelivery;
}): number {
  let cancelled = 0;
  for (const pending of params.manager.listPendingRecords()) {
    if (pending.request.runId !== params.runId) {
      continue;
    }
    const result = params.manager.forceDenyDetailed(
      pending.id,
      "run-aborted",
      { kind: "system", id: null },
      "cancelled",
    );
    if (result.outcome !== "denied" || !result.liveRecord) {
      continue;
    }
    cancelled += 1;
    void publishAppliedApprovalResolution({
      record: result.record,
      liveRecord: result.liveRecord,
      context: params.context,
      forwarder: params.forwarder,
      iosPushDelivery: params.iosPushDelivery,
    }).catch((error: unknown) => {
      params.context.logGateway?.error?.(
        `exec approvals: run-abort publication failed: ${String(error)}`,
      );
    });
  }
  return cancelled;
}
