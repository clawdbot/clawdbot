import { formatCliCommand } from "../cli/command-format.js";
import type { SecurityAuditFinding, SecurityAuditReport } from "./audit.types.js";

export function collectDeepProbeFindings(params: {
  deep?: SecurityAuditReport["deep"];
  authWarning?: string;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (params.deep?.gateway?.attempted && !params.deep.gateway.ok) {
    findings.push({
      checkId: "gateway.probe_failed",
      severity: "warn",
      title: "Gateway probe failed (deep)",
      detail: params.deep.gateway.error ?? "gateway unreachable",
      remediation: `Run "${formatCliCommand("openclaw status --all")}" to debug connectivity/auth, then re-run "${formatCliCommand("openclaw security audit --deep")}".`,
    });
  }
  if (params.authWarning) {
    findings.push({
      checkId: "gateway.probe_auth_secretref_unavailable",
      severity: "warn",
      title: "Gateway probe auth SecretRef is unavailable",
      detail: params.authWarning,
      remediation: `Set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD in this shell or resolve the external secret provider, then re-run "${formatCliCommand("openclaw security audit --deep")}".`,
    });
  }
  return findings;
}
