// Runtime boundary for invoking the security audit implementation.
import { runSecurityAudit as runSecurityAuditImpl } from "./audit.js";

type RunSecurityAudit = typeof import("./audit.js").runSecurityAudit;

/** Runtime facade for the full security audit entrypoint. */
export function runSecurityAudit(
  ...args: Parameters<RunSecurityAudit>
): ReturnType<RunSecurityAudit> {
  return runSecurityAuditImpl(...args);
}
