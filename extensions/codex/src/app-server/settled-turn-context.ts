import {
  embeddedAgentLog,
  formatErrorMessage,
  type AgentMessage,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { serializeCodexMirrorSourceEvidence } from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

type SettledTurnFinalizationContext = EmbeddedRunAttemptResult["settledTurnFinalizationContext"];

function collectUniqueMessageIdentities(
  messages: readonly AgentMessage[],
): Map<string, number> | undefined {
  const identities = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const identity = readMirrorIdentity(message);
    if (!identity) {
      continue;
    }
    if (identities.has(identity)) {
      return undefined;
    }
    identities.set(identity, index);
  }
  return identities;
}

/** Freezes one complete active transcript branch through the settled tool-result boundary. */
function buildCodexSettledTurnFinalizationContext(params: {
  historyMessages: readonly AgentMessage[];
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
}): SettledTurnFinalizationContext | undefined {
  const boundaryMessage = params.settledMessages.findLast(
    (message) => message.role === "toolResult",
  );
  const boundaryIdentity = boundaryMessage ? readMirrorIdentity(boundaryMessage) : undefined;
  if (
    !boundaryMessage ||
    !boundaryIdentity ||
    !boundaryIdentity.startsWith(`${params.turnId}:tool:`)
  ) {
    return undefined;
  }

  const settledBoundaryIndex = params.settledMessages.indexOf(boundaryMessage);
  const requiredIdentities = params.settledMessages
    .slice(0, settledBoundaryIndex + 1)
    .map(readMirrorIdentity);
  if (
    requiredIdentities.length === 0 ||
    requiredIdentities.some((identity) => !identity) ||
    new Set(requiredIdentities).size !== requiredIdentities.length ||
    !requiredIdentities.includes(`${params.turnId}:prompt`)
  ) {
    return undefined;
  }

  const historyIdentities = collectUniqueMessageIdentities(params.historyMessages);
  const mirroredIdentities = collectUniqueMessageIdentities(params.mirroredMessages);
  if (!historyIdentities || !mirroredIdentities) {
    return undefined;
  }
  const mirroredBoundaryIndex = mirroredIdentities.get(boundaryIdentity);
  if (mirroredBoundaryIndex === undefined) {
    return undefined;
  }
  const mirroredThroughBoundary = params.mirroredMessages.slice(0, mirroredBoundaryIndex + 1);
  if (
    mirroredThroughBoundary.length !== requiredIdentities.length ||
    mirroredThroughBoundary.some(
      (message, index) => readMirrorIdentity(message) !== requiredIdentities[index],
    )
  ) {
    return undefined;
  }
  const historyBoundaryIndex = historyIdentities.get(boundaryIdentity);
  if (historyBoundaryIndex === undefined) {
    return undefined;
  }
  let previousHistoryIndex = -1;
  for (const mirroredMessage of mirroredThroughBoundary) {
    const identity = readMirrorIdentity(mirroredMessage);
    const historyIndex = identity ? historyIdentities.get(identity) : undefined;
    const historyMessage =
      historyIndex === undefined ? undefined : params.historyMessages[historyIndex];
    if (
      historyIndex === undefined ||
      historyIndex <= previousHistoryIndex ||
      historyIndex > historyBoundaryIndex ||
      !historyMessage ||
      serializeCodexMirrorSourceEvidence(historyMessage) !==
        serializeCodexMirrorSourceEvidence(mirroredMessage)
    ) {
      return undefined;
    }
    previousHistoryIndex = historyIndex;
  }

  // Clone before returning so later transcript/cache mutation cannot change the
  // exact application evidence authorized for the isolated finalization turn.
  const messages = Object.freeze(
    structuredClone(params.historyMessages.slice(0, historyBoundaryIndex + 1)),
  );
  return { source: "openclaw-transcript", messages };
}

/** Reads and freezes the current active transcript branch after mirroring has settled. */
export async function captureCodexSettledTurnFinalizationContext(params: {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
}): Promise<SettledTurnFinalizationContext | undefined> {
  try {
    const historyMessages = await readCodexMirroredSessionHistoryMessages(params);
    if (!historyMessages) {
      return undefined;
    }
    return buildCodexSettledTurnFinalizationContext({
      historyMessages,
      mirroredMessages: params.mirroredMessages,
      settledMessages: params.settledMessages,
      turnId: params.turnId,
    });
  } catch (error) {
    // Capture runs after tools have settled. Never let transcript I/O or cloning
    // bypass the caller's side-effect-aware incomplete-turn result.
    embeddedAgentLog.warn("codex settled-turn finalization context capture failed", {
      error: formatErrorMessage(error),
      turnId: params.turnId,
    });
    return undefined;
  }
}
