// Compat surface: openclaw/plugin-sdk/approval-gateway-runtime
// Provides stable helpers for resolving approvals over the gateway.

import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";

export async function resolveApprovalOverGateway(params: {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalDecision;
  gatewayUrl: string;
  clientDisplayName: string;
}): Promise<void> {
  const { gatewayUrl, approvalId, decision, cfg: _cfg, clientDisplayName: _cd } = params;
  const url = `${gatewayUrl}/api/exec-approvals/${encodeURIComponent(approvalId)}/resolve`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!response.ok) {
    throw new Error(
      `resolveApprovalOverGateway: ${response.status} ${response.statusText} for ${url}`,
    );
  }
}
