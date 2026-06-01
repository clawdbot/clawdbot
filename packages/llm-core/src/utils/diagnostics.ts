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
