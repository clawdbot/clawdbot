import {
  loadExecApprovals,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
  resolveExecModePolicy,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
} from "../infra/exec-approvals.js";

/**
 * Whether an installed plugin may consume host exec without bypassing an
 * approval boundary. Final tool policy must still retain both tools.
 */
export function hasApprovalFreeHostExecAuthority(params: {
  agentId?: string;
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  bypassHostApprovalFloors?: boolean;
}): boolean {
  const modePolicy = resolveExecModePolicy({
    mode: params.mode,
    security: params.security ?? "full",
    ask: params.ask ?? "off",
  });
  if (modePolicy.security !== "full" || modePolicy.ask !== "off") {
    return false;
  }
  if (params.bypassHostApprovalFloors === true) {
    return true;
  }
  try {
    const hostPolicy = resolveExecApprovalsFromFile({
      file: loadExecApprovals(),
      agentId: params.agentId,
      overrides: { security: "full", ask: "off" },
    }).agent;
    return (
      minSecurity(modePolicy.security, hostPolicy.security) === "full" &&
      maxAsk(modePolicy.ask, hostPolicy.ask) === "off"
    );
  } catch {
    return false;
  }
}
