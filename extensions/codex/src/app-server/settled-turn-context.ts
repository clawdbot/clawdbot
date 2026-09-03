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
import { serializeCodexMirrorSourceEvidence } from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

function freezeProjection(value: JsonValue): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeProjection(child);
    }
    Object.freeze(value);
  }
}

type CodexSettledTurnSelection = {
  model: string;
  modelProvider?: string;
  authProfileId?: string;
};

/** Only the Codex owner interprets this bounded, detached replay projection. */
export class CodexSettledTurnContext {
  readonly source = "harness";

  constructor(
    readonly data: JsonValue[],
    readonly selection: CodexSettledTurnSelection,
  ) {
    freezeProjection(data);
    Object.freeze(selection);
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
  const mirrored = params.mirroredMessages;
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
  let throughBoundary = false;
  for (const message of history) {
    const identity = readMirrorIdentity(message);
    if (identity) {
      if (seen.has(identity)) {
        rejectEvidence();
      }
      seen.add(identity);
      const expected = required.get(identity);
      if (expected) {
        if (
          identity !== requiredIds[matched] ||
          serializeCodexMirrorSourceEvidence(message) !==
            serializeCodexMirrorSourceEvidence(expected)
        ) {
          rejectEvidence();
        }
        matched += 1;
      }
    }
    if (!throughBoundary) {
      yield message;
    }
    throughBoundary ||= identity === boundaryIdentity;
  }
  if (!throughBoundary || matched !== requiredIds.length) {
    rejectEvidence();
  }
}

/** Verifies and freezes a complete replay projection while reading the active branch. */
export async function captureCodexSettledTurnFinalizationContext(
  params: CodexMirroredSessionHistoryTarget &
    SettledTurnMessages &
    Partial<CodexSettledTurnSelection>,
): Promise<CodexSettledTurnContext | undefined> {
  try {
    const { model, modelProvider, authProfileId } = params;
    if (!model) {
      throw new Error("Codex settled-turn model selection is unavailable");
    }
    return await readCodexMirroredSessionHistory(
      params,
      (messages) =>
        new CodexSettledTurnContext(
          projectSettledCodexMessages(verifiedSettledMessages(messages, params)),
          { model, modelProvider, authProfileId },
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
