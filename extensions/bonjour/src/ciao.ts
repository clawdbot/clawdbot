import { formatBonjourError } from "./errors.js";

const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;
const CIAO_INTERFACE_ASSERTION_MESSAGE_RE =
  /REACHED ILLEGAL STATE!?\s+IPV4 ADDRESS CHANGE FROM (?:DEFINED TO UNDEFINED|UNDEFINED TO DEFINED)!?/u;
const CIAO_NETMASK_ASSERTION_MESSAGE_RE =
  /IP ADDRESS VERSION MUST MATCH\.\s+NETMASK CANNOT HAVE A VERSION DIFFERENT FROM THE ADDRESS!?/u;

export type CiaoProcessErrorClassification =
  | { kind: "cancellation"; formatted: string }
  | { kind: "interface-assertion"; formatted: string }
  | { kind: "netmask-assertion"; formatted: string };

function collectCiaoProcessErrorCandidates(reason: unknown): unknown[] {
  const queue: unknown[] = [reason];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const nested of [
      record.cause,
      record.reason,
      record.original,
      record.error,
      record.data,
    ]) {
      if (nested != null && !seen.has(nested)) {
        queue.push(nested);
      }
    }
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        if (nested != null && !seen.has(nested)) {
          queue.push(nested);
        }
      }
    }
  }

  return candidates;
}

export function classifyCiaoProcessError(reason: unknown): CiaoProcessErrorClassification | null {
  for (const candidate of collectCiaoProcessErrorCandidates(reason)) {
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
  }
  return null;
}

export const classifyCiaoUnhandledRejection = classifyCiaoProcessError;

export function ignoreCiaoUnhandledRejection(reason: unknown): boolean {
  return classifyCiaoProcessError(reason) !== null;
}
