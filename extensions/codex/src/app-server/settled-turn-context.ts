import {
  embeddedAgentLog,
  formatErrorMessage,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import {
  readCodexMirroredSessionHistoryMessages,
  type CodexMirroredSessionHistoryTarget,
} from "./session-history.js";
import {
  readCodexMirrorSourceFingerprint,
  serializeCodexMirrorSourceEvidence,
} from "./transcript-mirror-attestation.js";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";

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

function adoptPersistedHostPrompt(params: {
  historyMessages: readonly AgentMessage[];
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
}): { historyMessages: readonly AgentMessage[]; mirroredMessages: readonly AgentMessage[] } {
  const promptIdentity = `${params.turnId}:prompt`;
  if (params.mirroredMessages.some((message) => readMirrorIdentity(message) === promptIdentity)) {
    return params;
  }
  const sourcePrompt = params.settledMessages[0];
  const sourceKey = (sourcePrompt as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  if (
    sourcePrompt?.role !== "user" ||
    readMirrorIdentity(sourcePrompt) !== promptIdentity ||
    typeof sourceKey !== "string" ||
    sourceKey.trim().length === 0
  ) {
    return params;
  }
  const matches = params.historyMessages.flatMap((message, index) =>
    message.role === "user" &&
    (message as { idempotencyKey?: unknown }).idempotencyKey === sourceKey
      ? [{ index, message }]
      : [],
  );
  const persistedPrompt = matches.length === 1 ? matches[0] : undefined;
  const persistedMetadata = persistedPrompt?.message as
    | { __openclaw?: { mirrorOrigin?: unknown } }
    | undefined;
  if (
    !persistedPrompt ||
    readMirrorIdentity(persistedPrompt.message) !== undefined ||
    readCodexMirrorSourceFingerprint(persistedPrompt.message) !== undefined ||
    persistedMetadata?.["__openclaw"]?.mirrorOrigin === "codex-app-server"
  ) {
    return params;
  }
  const sourceUpstreamText = readUpstreamUserText(sourcePrompt);
  const persistedUpstreamText = readUpstreamUserText(persistedPrompt.message);
  if (persistedUpstreamText !== undefined && persistedUpstreamText !== sourceUpstreamText) {
    return params;
  }
  let logicalPrompt = attachCodexMirrorIdentity(persistedPrompt.message, promptIdentity);
  if (sourceUpstreamText !== undefined) {
    logicalPrompt = attachUpstreamUserText(logicalPrompt, sourceUpstreamText);
  }
  if (
    serializeCodexMirrorSourceEvidence(logicalPrompt) !==
    serializeCodexMirrorSourceEvidence(sourcePrompt)
  ) {
    return params;
  }
  // Host-owned prompts are authoritative by durable turn key; adopt their identity
  // only in verification views so canonical channel metadata remains untouched.
  const historyMessages = [...params.historyMessages];
  historyMessages[persistedPrompt.index] = logicalPrompt;
  return { historyMessages, mirroredMessages: [logicalPrompt, ...params.mirroredMessages] };
}

/** Freezes one complete active transcript branch through the settled tool-result boundary. */
function buildCodexSettledTurnFinalizationContext(params: {
  historyMessages: readonly AgentMessage[];
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
}): SettledTurnFinalizationContext | undefined {
  const { historyMessages, mirroredMessages } = adoptPersistedHostPrompt(params);
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

  const historyIdentities = collectUniqueMessageIdentities(historyMessages);
  const mirroredIdentities = collectUniqueMessageIdentities(mirroredMessages);
  if (!historyIdentities || !mirroredIdentities) {
    return undefined;
  }
  const mirroredBoundaryIndex = mirroredIdentities.get(boundaryIdentity);
  if (mirroredBoundaryIndex === undefined) {
    return undefined;
  }
  const mirroredThroughBoundary = mirroredMessages.slice(0, mirroredBoundaryIndex + 1);
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
    const historyMessage = historyIndex === undefined ? undefined : historyMessages[historyIndex];
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
export async function captureCodexSettledTurnFinalizationContext(
  params: CodexMirroredSessionHistoryTarget & {
    mirroredMessages: readonly AgentMessage[];
    settledMessages: readonly AgentMessage[];
    turnId: string;
  },
): Promise<SettledTurnFinalizationContext | undefined> {
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
