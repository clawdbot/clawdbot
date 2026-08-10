/** Carries and discovers canonical terminal outcomes through thrown-error boundaries. */
import { isDeepStrictEqual } from "node:util";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";

const MAX_ERROR_CAUSE_NODES = 16;
const TERMINAL_OUTCOME_KEYS = new Set([
  "reason",
  "status",
  "error",
  "stopReason",
  "livenessState",
  "timeoutPhase",
  "providerStarted",
  "startedAt",
  "endedAt",
]);

type CauseChainVisitor<T> = (candidate: unknown) => T | undefined;

function readOwnDataProperty(
  candidate: object,
  property: PropertyKey,
): { present: boolean; value?: unknown } {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(candidate, property);
    return descriptor && "value" in descriptor
      ? { present: true, value: descriptor.value }
      : { present: false };
  } catch {
    return { present: false };
  }
}

function visitErrorCauseChain<T>(error: unknown, visitor: CauseChainVisitor<T>): T | undefined {
  let candidate = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < MAX_ERROR_CAUSE_NODES; depth += 1) {
    const result = visitor(candidate);
    if (result !== undefined) {
      return result;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      return undefined;
    }
    seen.add(candidate);
    const cause = readOwnDataProperty(candidate, "cause");
    if (!cause.present) {
      return undefined;
    }
    candidate = cause.value;
  }
  return undefined;
}

function terminalErrorMessage(error: unknown): string {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const message = readOwnDataProperty(error, "message").value;
    return typeof message === "string" && message ? message : "Agent run failed";
  }
  try {
    return String(error);
  } catch {
    return "Agent run failed";
  }
}

function readTerminalOutcomeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !TERMINAL_OUTCOME_KEYS.has(key)) {
      return undefined;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return undefined;
    }
    if (!descriptor || !("value" in descriptor)) {
      return undefined;
    }
    record[key] = descriptor.value;
  }
  return record;
}

function normalizeTerminalOutcome(value: unknown): AgentRunTerminalOutcome | undefined {
  const input = readTerminalOutcomeRecord(value);
  if (!input) {
    return undefined;
  }
  const reason = input.reason;
  const status = input.status;
  if (
    typeof reason !== "string" ||
    (status !== "ok" && status !== "error" && status !== "timeout")
  ) {
    return undefined;
  }
  const descriptorOutcome: AgentRunTerminalOutcome = {
    reason: reason as AgentRunTerminalOutcome["reason"],
    status,
  };
  for (const key of ["error", "stopReason", "livenessState"] as const) {
    if (key in input) {
      if (typeof input[key] !== "string") {
        return undefined;
      }
      descriptorOutcome[key] = input[key];
    }
  }
  if ("timeoutPhase" in input) {
    if (typeof input.timeoutPhase !== "string") {
      return undefined;
    }
    descriptorOutcome.timeoutPhase = input.timeoutPhase as AgentRunTerminalOutcome["timeoutPhase"];
  }
  if ("providerStarted" in input) {
    if (typeof input.providerStarted !== "boolean") {
      return undefined;
    }
    descriptorOutcome.providerStarted = input.providerStarted;
  }
  for (const key of ["startedAt", "endedAt"] as const) {
    if (key in input) {
      if (typeof input[key] !== "number" || !Number.isFinite(input[key])) {
        return undefined;
      }
      descriptorOutcome[key] = input[key];
    }
  }
  const canonicalOutcome = buildAgentRunTerminalOutcome({
    status,
    error: descriptorOutcome.error,
    stopReason: descriptorOutcome.stopReason,
    livenessState: descriptorOutcome.livenessState,
    timeoutPhase: descriptorOutcome.timeoutPhase,
    providerStarted: descriptorOutcome.providerStarted,
    startedAt: descriptorOutcome.startedAt,
    endedAt: descriptorOutcome.endedAt,
  });
  return isDeepStrictEqual(canonicalOutcome, descriptorOutcome) ? canonicalOutcome : undefined;
}

/** Carries a canonical terminal outcome when an embedded attempt exits by throwing. */
export class AgentRunTerminalOutcomeError extends Error {
  readonly terminalOutcome: AgentRunTerminalOutcome;

  constructor(error: unknown, terminalOutcome: AgentRunTerminalOutcome) {
    super(terminalErrorMessage(error), { cause: error });
    this.name = "AgentRunTerminalOutcomeError";
    this.terminalOutcome = terminalOutcome;
  }
}

/** Finds a canonical terminal outcome through ordinary error wrapper boundaries. */
export function findAgentRunTerminalOutcome(error: unknown): AgentRunTerminalOutcome | undefined {
  return visitErrorCauseChain(error, (candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return undefined;
    }
    try {
      if (candidate instanceof AgentRunTerminalOutcomeError) {
        return normalizeTerminalOutcome(readOwnDataProperty(candidate, "terminalOutcome").value);
      }
    } catch {
      return undefined;
    }
    return undefined;
  });
}

/** Matches an exact thrown value without invoking hostile cause accessors. */
export function errorCauseChainIncludes(error: unknown, target: unknown): boolean {
  return (
    visitErrorCauseChain(error, (candidate) =>
      Object.is(candidate, target) ? true : undefined,
    ) === true
  );
}

/** Detects the structured timeout markers accepted by the one-shot CLI boundary. */
export function hasStructuredTimeoutCause(error: unknown): boolean {
  return (
    visitErrorCauseChain(error, (candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return undefined;
      }
      return readOwnDataProperty(candidate, "name").value === "TimeoutError" ||
        readOwnDataProperty(candidate, "code").value === "ETIMEDOUT" ||
        readOwnDataProperty(candidate, "reason").value === "timeout"
        ? true
        : undefined;
    }) === true
  );
}
