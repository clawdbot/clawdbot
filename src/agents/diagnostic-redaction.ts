import { redactSecrets } from "../logging/redact.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";

export function redactAgentDiagnosticPayload(value: unknown): unknown {
  return redactSecrets(sanitizeDiagnosticPayload(value));
}
