// LLM Core module implements diagnostics behavior.
export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: Record<string, unknown>;
}

/** True when the provider explicitly refused the request payload. */
export function isProviderRefusalAssistantError(
  message: { diagnostics?: AssistantMessageDiagnostic[] } | null | undefined,
): boolean {
  return Boolean(
    message?.diagnostics?.some((diagnostic) => diagnostic.type === "provider_refusal"),
  );
}

/** Formats arbitrary thrown values into diagnostic-safe text. */
export function formatThrownValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

/** Extracts serializable diagnostic error fields from Error and non-Error throws. */
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
  if (!(error instanceof Error)) {
    return { name: "ThrownValue", message: formatThrownValue(error) };
  }
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name || undefined,
    message: error.message || error.name,
    stack: error.stack,
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
  };
}

/** Creates a timestamped assistant-message diagnostic entry. */
export function createAssistantMessageDiagnostic(
  type: string,
  error: unknown,
  details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
  return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

/** Appends a diagnostic while preserving existing message diagnostics. */
export function appendAssistantMessageDiagnostic(
  message: { diagnostics?: AssistantMessageDiagnostic[] },
  diagnostic: AssistantMessageDiagnostic,
): void {
  message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

const RUN_FAILURE_ORIGIN = Symbol.for("openclaw.runFailureOrigin");
type RunFailureOrigin = "runtime" | "provider";

// Thrown objects may have accessors or proxy traps; origin inspection must not execute getters.
function readErrorData(error: object, key: PropertyKey): unknown {
  try {
    return Object.getOwnPropertyDescriptor(error, key)?.value;
  } catch {
    return undefined;
  }
}

/** Read a bounded cause chain without retaining errors or invoking its accessors. */
export function getRunFailureOrigin(error: unknown): RunFailureOrigin | undefined {
  let candidate = error;
  for (let depth = 0; depth < 32 && candidate && typeof candidate === "object"; depth++) {
    const origin = readErrorData(candidate, RUN_FAILURE_ORIGIN);
    if (origin === "runtime" || origin === "provider") {
      return origin;
    }
    candidate = readErrorData(candidate, "cause");
  }
  return undefined;
}

/** Tag at the owning boundary; a provider control called by runtime code keeps its origin. */
export function withRunFailureOrigin(
  error: unknown,
  origin: RunFailureOrigin,
  signal?: AbortSignal,
): Error {
  const message =
    error && typeof error === "object"
      ? readErrorData(error, "message")
      : typeof error === "function"
        ? undefined
        : String(error);
  return Object.defineProperty(
    new Error(typeof message === "string" ? message : "Unknown error", { cause: error }),
    RUN_FAILURE_ORIGIN,
    {
      // Known failures retain their source; the first abort supplies provenance for replacements.
      value:
        getRunFailureOrigin(error) ??
        (signal?.aborted ? getRunFailureOrigin(signal.reason) : undefined) ??
        origin,
    },
  );
}

/** Project the original provider fields; provenance wrappers must not erase coded aborts. */
export function unwrapRunFailure(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 32 && current && typeof current === "object"; depth++) {
    const origin = readErrorData(current, RUN_FAILURE_ORIGIN);
    if (origin !== "runtime" && origin !== "provider") {
      break;
    }
    current = readErrorData(current, "cause");
  }
  return current;
}

/** Persist only the presentation fact, never the private cause or abort reason. */
export function appendRuntimeFailureDiagnostic(
  message: { stopReason: string; timestamp: number; diagnostics?: AssistantMessageDiagnostic[] },
  error: unknown,
  signal?: AbortSignal,
): void {
  // Keep the source already captured before a later caller abort. Transports
  // replacing an uncoded reason recover its origin from the first abort instead.
  const origin =
    getRunFailureOrigin(error) ??
    ((message.stopReason === "error" || message.stopReason === "aborted") && signal?.aborted
      ? getRunFailureOrigin(signal.reason)
      : undefined);
  if (
    origin === "runtime" &&
    !message.diagnostics?.some((d) => d.type === "synthesized_run_failure")
  ) {
    appendAssistantMessageDiagnostic(message, {
      type: "synthesized_run_failure",
      timestamp: message.timestamp,
    });
  }
}
