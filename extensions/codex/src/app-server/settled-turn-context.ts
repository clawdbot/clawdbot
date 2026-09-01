import {
  embeddedAgentLog,
  formatErrorMessage,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonValue } from "./protocol.js";
import {
  readCodexMirroredSessionHistory,
  type CodexMirroredSessionHistoryTarget,
} from "./session-history.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import {
  hasCodexMirrorOrigin,
  readCodexMirrorSourceFingerprint,
  serializeCodexMirrorSourceEvidence,
} from "./transcript-mirror-attestation.js";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";

function freezeProjection(value: JsonValue): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeProjection(child);
    }
    Object.freeze(value);
  }
}

/** Only the Codex owner interprets this bounded, detached replay projection. */
export class CodexSettledTurnContext {
  readonly source = "harness";

  constructor(readonly data: JsonValue[]) {
    freezeProjection(data);
    Object.freeze(this);
  }
}

type SettledTurnMessages = {
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
};

function rejectEvidence(): never {
  throw new Error("Codex settled-turn transcript does not match the settled turn");
}

function adoptPersistedHostPrompt(message: AgentMessage, source: AgentMessage): AgentMessage {
  const sourceText = readUpstreamUserText(source);
  const persistedText = readUpstreamUserText(message);
  if (
    readMirrorIdentity(message) !== undefined ||
    readCodexMirrorSourceFingerprint(message) !== undefined ||
    hasCodexMirrorOrigin(message) ||
    (persistedText !== undefined && persistedText !== sourceText)
  ) {
    rejectEvidence();
  }
  let logical = attachCodexMirrorIdentity(message, readMirrorIdentity(source)!);
  if (sourceText !== undefined) {
    logical = attachUpstreamUserText(logical, sourceText);
  }
  if (serializeCodexMirrorSourceEvidence(logical) !== serializeCodexMirrorSourceEvidence(source)) {
    rejectEvidence();
  }
  return logical;
}

/** Yields only the settled prefix, but exhausts suffix identity checks before accepting it. */
function* verifiedSettledMessages(
  history: Iterable<AgentMessage>,
  params: SettledTurnMessages,
): Generator<AgentMessage> {
  const promptIdentity = `${params.turnId}:prompt`;
  const boundaryIndex = params.settledMessages.findLastIndex(
    (message) => message.role === "toolResult",
  );
  const boundary = params.settledMessages[boundaryIndex];
  const boundaryIdentity = boundary && readMirrorIdentity(boundary);
  const requiredIds = params.settledMessages
    .slice(0, boundaryIndex + 1)
    .flatMap((message) => readMirrorIdentity(message) ?? []);
  if (
    !boundaryIdentity?.startsWith(`${params.turnId}:tool:`) ||
    requiredIds.length !== boundaryIndex + 1 ||
    new Set(requiredIds).size !== requiredIds.length ||
    !requiredIds.includes(promptIdentity)
  ) {
    rejectEvidence();
  }
  const sourcePrompt = params.settledMessages[0];
  const sourceKey = (sourcePrompt as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  const adoption =
    !params.mirroredMessages.some((message) => readMirrorIdentity(message) === promptIdentity) &&
    sourcePrompt?.role === "user" &&
    readMirrorIdentity(sourcePrompt) === promptIdentity &&
    typeof sourceKey === "string" &&
    sourceKey.trim().length > 0
      ? { prompt: sourcePrompt, key: sourceKey }
      : undefined;
  const mirrored = adoption
    ? [adoption.prompt, ...params.mirroredMessages]
    : params.mirroredMessages;
  const mirroredIds = mirrored.flatMap((message) => readMirrorIdentity(message) ?? []);
  const mirroredBoundaryIndex = mirrored.findIndex(
    (message) => readMirrorIdentity(message) === boundaryIdentity,
  );
  if (
    new Set(mirroredIds).size !== mirroredIds.length ||
    mirroredBoundaryIndex + 1 !== requiredIds.length ||
    requiredIds.some((id, index) => readMirrorIdentity(mirrored[index]!) !== id)
  ) {
    rejectEvidence();
  }
  const required = new Map(requiredIds.map((id, index) => [id, mirrored[index]!]));
  const seen = new Set<string>();
  let matched = 0;
  let hostPromptMatches = 0;
  let throughBoundary = false;
  for (const message of history) {
    let verificationMessage = message;
    if (
      adoption &&
      message.role === "user" &&
      (message as { idempotencyKey?: unknown }).idempotencyKey === adoption.key
    ) {
      hostPromptMatches += 1;
      if (hostPromptMatches > 1) {
        rejectEvidence();
      }
      verificationMessage = adoptPersistedHostPrompt(message, adoption.prompt);
    }
    const identity = readMirrorIdentity(verificationMessage);
    if (identity) {
      if (seen.has(identity)) {
        rejectEvidence();
      }
      seen.add(identity);
      const expected = required.get(identity);
      if (expected) {
        if (
          identity !== requiredIds[matched] ||
          serializeCodexMirrorSourceEvidence(verificationMessage) !==
            serializeCodexMirrorSourceEvidence(expected)
        ) {
          rejectEvidence();
        }
        matched += 1;
      }
    }
    if (!throughBoundary) {
      // Adoption is verification-only: replay the canonical persisted prompt, not its synthetic view.
      yield message;
    }
    throughBoundary ||= identity === boundaryIdentity;
  }
  if (!throughBoundary || matched !== requiredIds.length || (adoption && hostPromptMatches !== 1)) {
    rejectEvidence();
  }
}

/** Verifies and freezes a complete replay projection while reading the active branch. */
export async function captureCodexSettledTurnFinalizationContext(
  params: CodexMirroredSessionHistoryTarget & SettledTurnMessages,
): Promise<CodexSettledTurnContext | undefined> {
  try {
    return await readCodexMirroredSessionHistory(
      params,
      (messages) =>
        new CodexSettledTurnContext(
          projectSettledCodexMessages(verifiedSettledMessages(messages, params)),
        ),
    );
  } catch (error) {
    // Capture follows settled side effects; any failure must preserve the incomplete-turn result.
    embeddedAgentLog.warn("codex settled-turn finalization context capture failed", {
      error: formatErrorMessage(error),
      turnId: params.turnId,
    });
    return undefined;
  }
}
