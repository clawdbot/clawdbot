// QA Lab Matrix prompt builders keep scenario instructions deterministic.
import { randomUUID } from "node:crypto";

export function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with only this exact marker: ${token}`;
}

export function buildExactMarkerPrompt(token: string) {
  return `reply with only this exact marker: ${token}`;
}

export function buildMatrixQaToken(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function buildMatrixQuietStreamingPrompt(sutUserId: string, text: string) {
  return `${sutUserId} Quiet streaming QA check: reply exactly \`${text}\`.`;
}

export function buildMatrixPartialStreamingPrompt(sutUserId: string, text: string) {
  return `${sutUserId} Partial streaming QA check: reply exactly \`${text}\`.`;
}

export const MATRIX_QA_TOOL_PROGRESS_TASK_FILENAME = "QA_KICKOFF_TASK.md";
const MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME =
  "matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt";
const MATRIX_QA_TOOL_PROGRESS_COMMAND = "printf 'matrix-command-progress-start\\n'; sleep 2";

export function buildMatrixToolProgressTaskContent(text: string) {
  return [
    "Matrix tool progress QA task.",
    "Reply with only this exact marker and no other text:",
    text,
  ].join("\n");
}

export function buildMatrixToolProgressPrompt(sutUserId: string) {
  return [
    `${sutUserId} Tool progress QA check: call the read tool exactly once on \`${MATRIX_QA_TOOL_PROGRESS_TASK_FILENAME}\` before answering.`,
    `The QA harness must observe that read tool call; the only valid final marker is inside that file.`,
    `Do not guess or send any marker before the tool result returns.`,
    `Do not read \`HEARTBEAT.md\` for this check.`,
    `After that read completes, reply with only the exact marker from the file and no other text.`,
  ].join(" ");
}

export function buildMatrixToolProgressCommandPrompt(sutUserId: string, text: string) {
  return [
    `${sutUserId} Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${MATRIX_QA_TOOL_PROGRESS_COMMAND}\`.`,
    `The QA harness must observe that exec command preview and its completion as edits to one Matrix draft.`,
    `After that exec command completes or fails, reply exactly \`${text}\`.`,
  ].join(" ");
}

export function buildMatrixToolProgressErrorPrompt(sutUserId: string, text: string) {
  return [
    `${sutUserId} Tool progress error QA check: read \`missing-matrix-tool-progress-target.txt\` before answering.`,
    `After the read fails, reply exactly \`${text}\`.`,
  ].join(" ");
}

export function buildMatrixToolProgressMentionSafetyPrompt(sutUserId: string, text: string) {
  return [
    `${sutUserId} Tool progress QA check: read the missing workspace file \`${MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME}\` before answering.`,
    `The QA harness must observe that failed read in a Matrix tool-progress preview.`,
    `Do not guess or send any marker before the tool result returns.`,
    `After that read fails, reply exactly \`${text}\`.`,
  ].join(" ");
}

export function buildMatrixBlockStreamingPrompt(
  sutUserId: string,
  firstText: string,
  secondText: string,
) {
  return [
    `${sutUserId} Block streaming QA check: complete this whole sequence in one turn.`,
    `Step 1: send an assistant text block containing only this exact marker: \`${firstText}\`.`,
    "That first marker block must be emitted before any tool call.",
    "Step 2: after the first marker block, use the read tool exactly once on `QA_KICKOFF_TASK.md`.",
    `Step 3: after that read completes, send a final assistant text block containing only this exact marker: \`${secondText}\`.`,
    "Never put both markers in the same assistant text block.",
  ].join("\n");
}
