import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../logging/redact.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import { formatErrorMessage } from "./errors.js";

// Supplemental process output is display-only: message/cause/code feed retry and auth policy.
// Weak ownership also preserves frozen errors without retaining completed runs.
const diagnostics = new WeakMap<object, string>();

/** Attach operator diagnostics; callers must mask opaque credentials before attachment. */
export function attachErrorDiagnostic<T extends object>(error: T, diagnostic: string): T {
  diagnostics.set(
    error,
    sliceUtf16Safe(redactSensitiveText(diagnostic, { mode: "tools" }), 0, 2_048).trim(),
  );
  return error;
}

function findErrorDiagnostic(error: unknown): string | undefined {
  for (const candidate of collectNestedErrorCandidates(error)) {
    const diagnostic =
      candidate && typeof candidate === "object" ? diagnostics.get(candidate) : undefined;
    if (diagnostic) {
      return diagnostic;
    }
  }
  return undefined;
}

/** Preserve display metadata when an owner must clone a typed failure. */
export function copyErrorDiagnostic(source: unknown, target: object): void {
  const diagnostic = findErrorDiagnostic(source);
  if (diagnostic) {
    diagnostics.set(target, diagnostic);
  }
}

/** Terminal display only. Never classify this text or use it to decide retries. */
export function formatErrorMessageForDisplay(
  error: unknown,
  message = formatErrorMessage(error),
): string {
  const diagnostic = findErrorDiagnostic(error);
  return diagnostic ? `${message}\n${diagnostic}` : message;
}
