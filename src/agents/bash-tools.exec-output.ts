/**
 * Rendering helpers for exec output/status updates.
 * Keeps no-output placeholders and warning placement consistent across exec
 * progress, polling, and completion surfaces.
 */
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import type { TerminationReason } from "../process/supervisor/types.js";

const EXEC_NO_OUTPUT_PLACEHOLDER = "(no output)";
const EXEC_REDACTION_WARNING =
  "Warning: redacted secret-shaped output; masked values are not real source data and must not be written back.";
const EXEC_TIMEOUT_RETRY_GUIDANCE =
  "The command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.";

type RedactedText = {
  text: string;
  redacted: boolean;
};

export function redactExecOutputText(value: string): RedactedText {
  const text = redactToolPayloadText(value);
  return { text, redacted: text !== value };
}

export function redactExecDetails<T>(details: T): { details: T; redacted: boolean } {
  const redactedDetails = redactSecrets(details);
  return {
    details: redactedDetails,
    redacted: JSON.stringify(redactedDetails) !== JSON.stringify(details),
  };
}

export function withRedactionMarker<T extends Record<string, unknown>>(
  details: T,
  redacted: boolean,
): T & { redacted?: true } {
  return redacted ? ({ ...details, redacted: true } as T & { redacted: true }) : details;
}

export function prependRedactionWarning(text: string, redacted: boolean): string {
  return redacted ? `${EXEC_REDACTION_WARNING}\n\n${text}` : text;
}

export function buildExecUpdateResult(params: {
  tailText: string;
  tail: string;
  warnings?: string[];
  status: "running";
  sessionId: string;
  pid?: number;
  startedAt: number;
  cwd?: string;
}) {
  const tailText = redactExecOutputText(params.tailText);
  const tail = redactExecOutputText(params.tail);
  const warnings = params.warnings?.map((warning) => redactExecOutputText(warning)) ?? [];
  const details = redactExecDetails({
    status: params.status,
    sessionId: params.sessionId,
    pid: params.pid,
    startedAt: params.startedAt,
    cwd: params.cwd,
    tail: tail.text,
  });
  const redacted =
    tailText.redacted ||
    tail.redacted ||
    warnings.some((warning) => warning.redacted) ||
    details.redacted;
  return {
    content: [
      {
        type: "text" as const,
        text: renderExecUpdateText({
          tailText: tailText.text,
          warnings: warnings.map((warning) => warning.text),
          redacted,
        }),
      },
    ],
    details: withRedactionMarker(details.details, redacted),
  };
}
/** Render command output with a stable placeholder for empty output. */
export function renderExecOutputText(value: string | undefined): string {
  return value || EXEC_NO_OUTPUT_PLACEHOLDER;
}

/** Render the text shown in exec progress updates, including warnings first. */
export function renderExecUpdateText(params: {
  tailText?: string;
  warnings: string[];
  redacted?: boolean;
}): string {
  const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";
  return prependRedactionWarning(
    warningText + renderExecOutputText(params.tailText),
    Boolean(params.redacted),
  );
}

/** Add retry-safety guidance only for supervisor timeout exits. */
export function appendExecTimeoutRetryGuidance(
  text: string,
  exitReason: TerminationReason | undefined,
): string {
  if (exitReason !== "overall-timeout" && exitReason !== "no-output-timeout") {
    return text;
  }
  return `${text}\n\n${EXEC_TIMEOUT_RETRY_GUIDANCE}`;
}
