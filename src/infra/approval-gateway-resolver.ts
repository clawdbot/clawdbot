import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { isApprovalNotFoundError } from "./approval-errors.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";

export type ResolveApprovalOverGatewayParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalDecision;
  senderId?: string | null;
  allowPluginFallback?: boolean;
  gatewayUrl?: string;
  clientDisplayName?: string;
};

export async function resolveApprovalOverGateway(
  params: ResolveApprovalOverGatewayParams,
): Promise<void> {
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady();
  };
  const failReady = (err: unknown) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(err);
  };

  const gatewayClient = await createOperatorApprovalsGatewayClient({
    config: params.cfg,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName:
      params.clientDisplayName ?? `Approval (${params.senderId?.trim() || "unknown"})`,
    onHelloOk: markReady,
    onConnectError: failReady,
    onClose: (code, reason) => {
      failReady(new Error(`gateway closed (${code}): ${reason}`));
    },
  });

  try {
    gatewayClient.start();
    await ready;
    const requestResolve = async (method: "exec.approval.resolve" | "plugin.approval.resolve") => {
      await gatewayClient.request(method, {
        id: params.approvalId,
        decision: params.decision,
      });
    };
    if (params.approvalId.startsWith("plugin:")) {
      await requestResolve("plugin.approval.resolve");
      return;
    }
    try {
      await requestResolve("exec.approval.resolve");
    } catch (err) {
      if (!params.allowPluginFallback || !isApprovalNotFoundError(err)) {
        throw err;
      }
      await requestResolve("plugin.approval.resolve");
    }
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}
