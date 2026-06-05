/**
 * Ciao process-error classifier. It recognizes known noisy ciao failures so
 * the Bonjour plugin can suppress or repair expected mDNS lifecycle issues.
 */
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { formatBonjourError } from "./errors.js";

const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;
const CIAO_INTERFACE_ASSERTION_MESSAGE_RE =
  /REACHED ILLEGAL STATE!?\s+IPV4 ADDRESS CHANGED? FROM (?:DEFINED TO UNDEFINED|UNDEFINED TO DEFINED)!?/u;
const CIAO_NETMASK_ASSERTION_MESSAGE_RE =
  /IP ADDRESS VERSION MUST MATCH\.\s+NETMASK CANNOT HAVE A VERSION DIFFERENT FROM THE ADDRESS!?/u;
const CIAO_SELF_PROBE_MESSAGE_RE =
  /CAN'T PROBE FOR A SERVICE WHICH IS ANNOUNCED ALREADY\.\s+RECEIVED (?:PROBING|ANNOUNCING|ANNOUNCED) FOR SERVICE\b/u;
// Restricted sandboxes (NemoClaw, Docker-in-Docker, k3s with locked-down policy)
// can refuse os.networkInterfaces(), which ciao calls during NetworkManager init.
// Node surfaces this as a SystemError mentioning the libuv syscall by name.
const CIAO_INTERFACE_ENUMERATION_FAILURE_RE = /\bUV_INTERFACE_ADDRESSES\b/u;

/** Known ciao process-level errors that OpenClaw handles specially. */
export type CiaoProcessErrorClassification =
  | { kind: "cancellation"; formatted: string }
  | { kind: "interface-assertion"; formatted: string }
  | { kind: "netmask-assertion"; formatted: string }
  | { kind: "self-probe"; formatted: string }
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
    if (CIAO_CANCELLATION_MESSAGE_RE.test(message)) {
      return { kind: "cancellation", formatted };
    }
    if (CIAO_INTERFACE_ASSERTION_MESSAGE_RE.test(message)) {
      return { kind: "interface-assertion", formatted };
    }
    if (CIAO_NETMASK_ASSERTION_MESSAGE_RE.test(message)) {
      return { kind: "netmask-assertion", formatted };
    }
    if (CIAO_SELF_PROBE_MESSAGE_RE.test(message)) {
      return { kind: "self-probe", formatted };
    }
    if (CIAO_INTERFACE_ENUMERATION_FAILURE_RE.test(message)) {
      return { kind: "interface-enumeration-failure", formatted };
    }
  }
  return null;
}

/**
 * Backward-compatible alias for unhandled-rejection classification.
 *
 * @deprecated Use classifyCiaoProcessError.
 */
export const classifyCiaoUnhandledRejection = classifyCiaoProcessError;

/** Return whether a ciao unhandled rejection is known and ignorable. */
export function ignoreCiaoUnhandledRejection(reason: unknown): boolean {
  return classifyCiaoProcessError(reason) !== null;
}
