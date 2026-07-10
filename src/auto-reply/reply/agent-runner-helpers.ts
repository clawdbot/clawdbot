/** Helper predicates and gates used while streaming agent-runner payloads. */
import { isAudioFileName } from "@openclaw/media-core/mime";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { resolveVerboseKinds, type VerboseKinds, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

/** Returns true when a payload carries audio media. */
export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);

type VerboseGateParams = {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
};

const VERBOSE_GATE_SESSION_REFRESH_MS = 250;

function readCurrentVerboseKinds(params: VerboseGateParams): VerboseKinds | undefined {
  if (!params.sessionKey || !params.storePath) {
    return undefined;
  }
  try {
    const entry = loadSessionEntryReadOnly({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      clone: false,
    });
    return typeof entry?.verboseLevel === "string"
      ? resolveVerboseKinds(entry.verboseLevel)
      : undefined;
  } catch {
    // ignore store read failures
    return undefined;
  }
}

function createCurrentVerboseKindsResolver(
  params: VerboseGateParams,
): () => VerboseKinds | undefined {
  let cachedKinds: VerboseKinds | undefined;
  let cachedAtMs = Number.NEGATIVE_INFINITY;
  return () => {
    if (!params.sessionKey || !params.storePath) {
      return undefined;
    }
    const now = Date.now();
    if (now - cachedAtMs < VERBOSE_GATE_SESSION_REFRESH_MS) {
      return cachedKinds;
    }
    cachedKinds = readCurrentVerboseKinds(params);
    cachedAtMs = now;
    return cachedKinds;
  };
}

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (kinds: VerboseKinds) => boolean,
): () => boolean {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackKinds = resolveVerboseKinds(params.resolvedVerboseLevel);
  const resolveCurrentVerboseKinds = createCurrentVerboseKindsResolver(params);
  return () => {
    const kinds = resolveCurrentVerboseKinds() ?? fallbackKinds;
    return kinds ? shouldEmit(kinds) : false;
  };
}

/** Creates the visibility gate for tool result summaries. */
export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (kinds) => kinds.toolSummaries);
};

/** Creates the visibility gate for command/tool output streams. */
export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (kinds) => kinds.toolOutput);
};

/** Sends typing signals for visible text payloads when typing is enabled. */
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
