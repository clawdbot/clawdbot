import { redactSecrets } from "../logging/redact.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";

export function redactAgentDiagnosticPayload<T>(value: T): T {
  return redactSecrets(sanitizeDiagnosticPayload(value)) as T;
}
