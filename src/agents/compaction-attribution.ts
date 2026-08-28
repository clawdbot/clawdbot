import { generateSecureToken } from "../infra/secure-random.js";

export type RequestCompactionInvocation = {
  sessionKey: string;
  sessionId: string;
  runId?: string;
  diagId: string;
  trigger: "volitional";
  reason: string;
  customInstructions?: string;
  contextUsage: number;
  requestedAtMs: number;
  traceparent?: string;
};

export type CompactionCounterAttribution = {
  runId?: string;
  trigger: string;
  outcome: string;
};

export function createCompactionDiagId(now = Date.now()): string {
  return `cmp-${now.toString(36)}-${generateSecureToken(4)}`;
}

export function normalizeCompactionTrigger(value: unknown): string {
  if (value === "threshold") {
    return "budget";
  }
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}
