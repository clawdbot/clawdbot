// Runtime boundary for collecting channel security audit findings.
import { collectChannelSecurityFindings as collectChannelSecurityFindingsImpl } from "./audit-channel.js";

type CollectChannelSecurityFindings =
  typeof import("./audit-channel.js").collectChannelSecurityFindings;

/** Runtime facade for channel security collection, kept mockable for audit tests. */
export function collectChannelSecurityFindings(
  ...args: Parameters<CollectChannelSecurityFindings>
): ReturnType<CollectChannelSecurityFindings> {
  return collectChannelSecurityFindingsImpl(...args);
}
