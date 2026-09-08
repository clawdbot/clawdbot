import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { renderUserFacingText } from "../agents/embedded-agent-helpers/user-facing-text.js";
import {
  appendSessionTranscriptReport,
  type SessionTranscriptWriteScope,
} from "../config/sessions/session-accessor.js";
import { redactSensitiveText } from "../logging/redact.js";

const SESSION_RUN_ERROR_MAX_CHARS = 160;
const RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE = "run-failed-before-reply";

function sanitizeSessionRunError(error: unknown, maxChars: number): string {
  const text = renderUserFacingText(error, { errorContext: true }).replace(/\s+/g, " ").trim();
  return truncateUtf16Safe(redactSensitiveText(text, { mode: "tools" }), maxChars);
}

/** Shared transcript outcome for owners that already committed a failed run. */
export async function recordGatewaySessionRunFailure(params: {
  target: SessionTranscriptWriteScope & { sessionId: string };
  runId: string;
  error: unknown;
  assertCommitAllowed?: () => void;
}): Promise<void> {
  const { runId } = params;
  const error = sanitizeSessionRunError(params.error, 512) || "unknown error";
  const result = await appendSessionTranscriptReport(params.target, {
    kind: "custom",
    customTypes: [RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE],
    suppressWhenAssistantRun: runId,
    selectReport: (latest) => {
      params.assertCommitAllowed?.();
      if (isRecord(latest?.details) && latest.details.runId === runId) {
        return undefined;
      }
      return {
        customType: RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE,
        content: `This turn did not run: ${error}.`,
        display: true,
        details: { runId, error },
      };
    },
  });
  if (!result.ok) {
    throw new Error(`Failed run notice could not be appended: ${result.error.code}`);
  }
}

export function resolveSessionRunError(
  outcome: { error?: string },
  status: SessionRunStatus,
): string | undefined {
  if (
    (status !== "failed" && status !== "timeout") ||
    typeof outcome.error !== "string" ||
    !outcome.error.trim()
  ) {
    return undefined;
  }
  return sanitizeSessionRunError(outcome.error, SESSION_RUN_ERROR_MAX_CHARS) || undefined;
}
