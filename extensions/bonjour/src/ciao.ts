/**
 * Ciao process-error classifier. It recognizes known noisy ciao failures so
 * the Bonjour plugin can suppress or repair expected mDNS lifecycle issues.
 */
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { formatBonjourError } from "./errors.js";

const CIAO_NETMASK_ASSERTION_MESSAGE_RE =
  /IP ADDRESS VERSION MUST MATCH\.\s+NETMASK CANNOT HAVE A VERSION DIFFERENT FROM THE ADDRESS!?/u;
// Restricted sandboxes (NemoClaw, Docker-in-Docker, k3s with locked-down policy)
// can refuse os.networkInterfaces(), which ciao calls during NetworkManager init.
// Node surfaces this as a SystemError mentioning the libuv syscall by name.
const CIAO_INTERFACE_ENUMERATION_FAILURE_RE = /\bUV_INTERFACE_ADDRESSES\b/u;

/** Known ciao process-level errors that OpenClaw handles specially. */
type CiaoProcessErrorClassification =
  | { kind: "netmask-assertion"; formatted: string }
  | { kind: "interface-enumeration-failure"; formatted: string };

/** Classify a ciao error/rejection chain into a known category. */
export function classifyCiaoProcessError(reason: unknown): CiaoProcessErrorClassification | null {
  for (const candidate of collectErrorGraphCandidates(reason, (current) => [
    current.cause,
    current.reason,
    current.original,
    current.error,
    current.data,
    ...(Array.isArray(current.errors) ? current.errors : []),
  ])) {
    const formatted = formatBonjourError(candidate);
    const message = formatted.toUpperCase();
    if (CIAO_NETMASK_ASSERTION_MESSAGE_RE.test(message)) {
      return { kind: "netmask-assertion", formatted };
    }
    if (CIAO_INTERFACE_ENUMERATION_FAILURE_RE.test(message)) {
      return { kind: "interface-enumeration-failure", formatted };
    }
  }
  return null;
}
