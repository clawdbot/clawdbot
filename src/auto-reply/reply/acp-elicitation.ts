import type { AcpElicitationRequest } from "@openclaw/acp-core/runtime/types";
import {
  compileStructuredInputForm,
  compileStructuredInputUrl,
  isStructuredInputRecord,
  snapshotStructuredInput,
  type StructuredInputCompileResult,
  type StructuredInputRecord,
  type StructuredInputValue,
} from "../../agents/harness/structured-input.js";

const MAX_CORRELATION_TEXT = 128;

type ParsedAcpElicitationRequest = {
  input: StructuredInputCompileResult;
  correlation?:
    | { sessionId: string; toolCallId?: string | null }
    | { requestId: string | number | null };
};

/** Adapts ACP wire scope and codex-acp metadata into the shared structured-input compiler. */
export function parseAcpElicitationRequest(
  request: AcpElicitationRequest,
): ParsedAcpElicitationRequest {
  const snapshot = snapshotStructuredInput(request);
  if (!isStructuredInputRecord(snapshot)) {
    return unsupported("OpenClaw declined a malformed or over-limit ACP input request.");
  }
  const correlation = readScope(snapshot);
  if (typeof correlation === "string") {
    return unsupported(correlation);
  }
  const mode = readAcpElicitationString(snapshot, "mode");
  if (mode === "url") {
    return {
      correlation,
      input: compileStructuredInputUrl({
        url: readValue(snapshot, "url"),
        elicitationId: readValue(snapshot, "elicitationId"),
        message: readValue(snapshot, "message"),
        fallbackMessage: "ACP provided a URL",
        protocolName: "ACP",
      }),
    };
  }
  if (mode !== "form") {
    return unsupported(
      `OpenClaw does not support ACP elicitation mode ${JSON.stringify(mode ?? "unknown")}.`,
    );
  }
  return {
    correlation,
    input: compileStructuredInputForm({
      schema: readValue(snapshot, "requestedSchema"),
      message: readAcpElicitationString(snapshot, "message"),
      fallbackMessage: "ACP needs input",
      options: {
        protocolName: "ACP",
        minimumChoiceCount: 2,
        booleanLabels: ["True", "False"],
        metadata: {
          secretPath: ["_meta", "codex", "isSecret"],
          otherAnswerPath: ["_meta", "codex", "isOtherAnswer"],
          otherQuestionIdPath: ["_meta", "codex", "questionId"],
        },
      },
    }),
  };
}

function readScope(
  request: StructuredInputRecord,
): ParsedAcpElicitationRequest["correlation"] | string {
  const sessionId = readValue(request, "sessionId");
  const requestId = readValue(request, "requestId");
  const hasSession = sessionId !== undefined;
  const hasRequest = requestId !== undefined;
  if (hasSession === hasRequest) {
    return "OpenClaw declined an ACP input request with an invalid or ambiguous scope.";
  }
  if (hasSession) {
    const normalizedSessionId = readCorrelationText(sessionId);
    if (!normalizedSessionId) {
      return "OpenClaw declined an ACP input request with an invalid session id.";
    }
    const toolCallId = readValue(request, "toolCallId");
    const normalizedToolCallId =
      toolCallId === undefined || toolCallId === null
        ? toolCallId
        : readCorrelationText(toolCallId);
    if (toolCallId !== undefined && toolCallId !== null && !normalizedToolCallId) {
      return "OpenClaw declined an ACP input request with an invalid tool-call id.";
    }
    return {
      sessionId: normalizedSessionId,
      ...(toolCallId === undefined ? {} : { toolCallId: normalizedToolCallId ?? null }),
    };
  }
  if (requestId === null) {
    return { requestId };
  }
  if (typeof requestId === "number") {
    return { requestId };
  }
  const normalizedRequestId = readCorrelationText(requestId);
  return normalizedRequestId
    ? { requestId: normalizedRequestId }
    : "OpenClaw declined an ACP input request with an invalid request scope.";
}

function readCorrelationText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CORRELATION_TEXT) {
    return undefined;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return undefined;
    }
  }
  return value;
}

function readValue(record: StructuredInputRecord, key: string): StructuredInputValue | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readAcpElicitationString(record: StructuredInputRecord, key: string): string | undefined {
  const value = readValue(record, key);
  return typeof value === "string" ? value : undefined;
}

function unsupported(message: string): ParsedAcpElicitationRequest {
  return { input: { kind: "unsupported", message } };
}
