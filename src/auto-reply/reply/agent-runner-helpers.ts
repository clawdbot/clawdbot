import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { loadSessionStore } from "../../config/sessions.js";
import { isAudioFileName } from "../../media/mime.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { scheduleFollowupDrain } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);

type VerboseGateParams = {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
};

function resolveCurrentVerboseLevel(params: VerboseGateParams): VerboseLevel | undefined {
  if (!params.sessionKey || !params.storePath) {
    return undefined;
  }
  try {
    const store = loadSessionStore(params.storePath);
    const entry = store[params.sessionKey];
    return typeof entry?.verboseLevel === "string"
      ? normalizeVerboseLevel(entry.verboseLevel)
      : undefined;
  } catch {
    // ignore store read failures
    return undefined;
  }
}

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (level: VerboseLevel) => boolean,
): () => boolean {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = params.resolvedVerboseLevel;
  return () => {
    return shouldEmit(resolveCurrentVerboseLevel(params) ?? fallbackVerbose);
  };
}

export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level !== "off");
};

export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level === "full");
};

export const finalizeWithFollowup = <T>(
  value: T,
  queueKey: string,
  runFollowupTurn: Parameters<typeof scheduleFollowupDrain>[1],
): T => {
  scheduleFollowupDrain(queueKey, runFollowupTurn);
  return value;
};

export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
): Promise<void> => {
  const shouldSignalTyping = payloads.some((payload) =>
    hasOutboundReplyContent(payload, { trimText: true }),
  );
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};
