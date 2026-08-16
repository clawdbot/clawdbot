import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { generateConversationLabelWithFallback } from "../auto-reply/reply/conversation-label-generator.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTimeout } from "../infra/fs-safe.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { isValidAttachmentBase64, type ChatAttachment } from "./chat-attachments.js";
import { readSessionTitleFieldsFromTranscript } from "./session-transcript-title-reader.js";

type DashboardSessionTitleModelEntry = Pick<
  SessionEntry,
  | "agentHarnessId"
  | "agentRuntimeOverride"
  | "authProfileOverride"
  | "model"
  | "modelOverride"
  | "modelProvider"
  | "modelSelectionLocked"
  | "providerOverride"
>;

const DASHBOARD_SESSION_TITLE_MAX_CHARS = 60;
const DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;
const WORKTREE_SESSION_TITLE_TIMEOUT_MS = 8_000;
const WORKTREE_SESSION_TITLE_ATTEMPT_TIMEOUT_MS = 4_000;
const DASHBOARD_SESSION_TITLE_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return only the title.";

// One title request per session generation. Concurrent triggers cannot race duplicate model
// calls or metadata writes; late callers receive the in-flight promise so they
// may await the persisted title before proceeding. Stored promises always
// settle: isolated completion enforces a timeout, so a hung model call cannot
// pin an entry here and block future attempts.
const sessionTitleRequests = new Map<string, Promise<boolean>>();

function decodeTextAttachmentPrefix(attachment: ChatAttachment, maxChars: number): string | null {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  const content = attachment.content;
  if (!mimeType?.startsWith("text/") || typeof content !== "string" || !content) {
    return null;
  }
  if (!isValidAttachmentBase64(content)) {
    return null;
  }
  // Three UTF-8 bytes per UTF-16 code unit plus one partial code point is sufficient
  // to fill the title cap without decoding a multi-megabyte pasted attachment.
  const maxBase64Chars = Math.ceil((maxChars * 3 + 3) / 3) * 4;
  const truncated = content.length > maxBase64Chars;
  const prefixLength = truncated ? maxBase64Chars : content.length;
  const prefix = content.slice(0, prefixLength);
  const bytes = Buffer.from(prefix, "base64");
  try {
    // Streaming mode withholds an incomplete trailing code point while still
    // rejecting malformed UTF-8 inside the bounded prefix.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return null;
  }
}

/** Builds the bounded model source shared by dashboard and worktree titles. */
export function buildDashboardSessionTitleSource(params: {
  message: string;
  attachments?: readonly ChatAttachment[];
}): string {
  const visibleMessage = stripInlineDirectiveTagsForDisplay(params.message).text.trim();
  const slashCommand = visibleMessage.startsWith("/");
  let source = slashCommand ? "" : visibleMessage;
  for (const attachment of params.attachments ?? []) {
    const separatorLength = source ? 1 : 0;
    const remaining = DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS - source.length - separatorLength;
    if (remaining <= 0) {
      break;
    }
    const text = decodeTextAttachmentPrefix(attachment, remaining)?.trim();
    if (!text) {
      continue;
    }
    source += `${source ? "\n" : ""}${truncateUtf16Safe(text, remaining)}`;
  }
  if (!source && slashCommand) {
    return truncateUtf16Safe(visibleMessage, DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS);
  }
  return truncateUtf16Safe(source.trim(), DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS);
}

type SessionTitleAttempt =
  | { kind: "persisted" }
  | { kind: "skipped" }
  | { kind: "in-flight"; settled: Promise<boolean> };

export function hasExplicitSessionName(entry: SessionEntry | undefined): boolean {
  return Boolean(
    entry?.label?.trim() ||
    entry?.displayName?.trim() ||
    entry?.subject?.trim() ||
    entry?.groupChannel?.trim() ||
    entry?.space?.trim(),
  );
}

function isDashboardSessionKey(sessionKey: string): boolean {
  return parseAgentSessionKey(sessionKey)?.rest.startsWith("dashboard:") === true;
}

export function isDashboardSessionTitleCandidate(params: {
  sessionKey: string;
  userMessage: string;
}): boolean {
  const sourceText = params.userMessage.trim();
  return Boolean(
    sourceText && !sourceText.startsWith("/") && isDashboardSessionKey(params.sessionKey),
  );
}

function resolveDashboardTitleAuthProfile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: DashboardSessionTitleModelEntry | undefined;
  regularProvider: string;
}): string | undefined {
  const sessionProfile = params.entry?.authProfileOverride?.trim();
  if (sessionProfile) {
    return sessionProfile;
  }
  const configuredRef = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId)?.trim();
  const configuredProfile = configuredRef
    ? splitTrailingAuthProfile(configuredRef).profile
    : undefined;
  if (!configuredProfile) {
    return undefined;
  }
  const configuredModel = resolveSessionModelRef(params.cfg, undefined, params.agentId);
  return configuredModel.provider === params.regularProvider ? configuredProfile : undefined;
}

function normalizeDashboardSessionTitle(raw: string): string | null {
  const firstLine = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("```"));
  if (!firstLine) {
    return null;
  }
  const unwrapped = firstLine.replace(/^\s*(?:title\s*:\s*)?/i, "").replace(/^["'`]+|["'`]+$/g, "");
  const normalized = unwrapped.replace(/\s+/g, " ").trim();
  return normalized ? truncateUtf16Safe(normalized, DASHBOARD_SESSION_TITLE_MAX_CHARS) : null;
}

async function generateDashboardSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry?: DashboardSessionTitleModelEntry;
  userMessage: string;
  attachments?: readonly ChatAttachment[];
  timeoutMs?: number;
}): Promise<string | null> {
  const sourceText = buildDashboardSessionTitleSource({
    message: params.userMessage,
    attachments: params.attachments,
  });
  if (!sourceText || sourceText.startsWith("/")) {
    return null;
  }
  const regularModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider: regularModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const preferredProfile = resolveDashboardTitleAuthProfile({
    cfg: params.cfg,
    agentId: params.agentId,
    entry: params.entry,
    regularProvider: regularModel.provider,
  });
  const regularModelRef = `${regularModel.provider}/${regularModel.model}${
    preferredProfile ? `@${preferredProfile}` : ""
  }`;
  const utilityModelRef = resolveUtilityModelRefForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: regularModel.provider,
    primaryModelRef: regularModelRef,
  });
  const generated = await generateConversationLabelWithFallback({
    userMessage: truncateUtf16Safe(sourceText, DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS),
    prompt: DASHBOARD_SESSION_TITLE_PROMPT,
    cfg: params.cfg,
    agentId: params.agentId,
    ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
    ...(utilityModelRef ? { utilityModelRef } : {}),
    regularModelRef,
    ...(preferredProfile ? { preferredProfile } : {}),
    normalizeLabel: normalizeDashboardSessionTitle,
    maxLength: DASHBOARD_SESSION_TITLE_MAX_CHARS,
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
  });
  return generated ? normalizeDashboardSessionTitle(generated) : null;
}

export function prepareWorktreeSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry?: DashboardSessionTitleModelEntry;
  userMessage: string;
  attachments?: readonly ChatAttachment[];
  onError: (error: unknown) => void;
}) {
  const source = buildDashboardSessionTitleSource({
    message: params.userMessage,
    attachments: params.attachments,
  });
  if (!source) {
    return undefined;
  }
  const generated = withTimeout(
    generateDashboardSessionTitle({
      ...params,
      timeoutMs: WORKTREE_SESSION_TITLE_ATTEMPT_TIMEOUT_MS,
    }),
    WORKTREE_SESSION_TITLE_TIMEOUT_MS,
    "worktree title generation",
  ).catch((error: unknown) => {
    params.onError(error);
    return null;
  });
  return {
    source,
    generated,
    persist: async (
      agentId: string,
      entry: SessionEntry,
      sessionKey: string,
      storePath: string,
    ) => {
      try {
        const attempt = await maybeGenerateSessionTitle({
          cfg: params.cfg,
          agentId,
          entry,
          sessionId: entry.sessionId,
          sessionKey,
          storePath,
          userMessage: source,
          titleGeneration: generated,
        });
        return attempt.kind === "persisted";
      } catch (error) {
        params.onError(error);
        return false;
      }
    },
  };
}

export async function maybeGenerateDashboardSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  currentUserMessage?: string;
  userMessage: string;
}): Promise<boolean> {
  const sourceText = params.userMessage.trim();
  if (
    !isDashboardSessionTitleCandidate({
      sessionKey: params.sessionKey,
      userMessage: sourceText,
    })
  ) {
    return false;
  }
  // Dashboard sends never wait on a duplicate request: only the owning call
  // may claim persistence (and emit sessions.changed), duplicates skip fast.
  const attempt = await maybeGenerateSessionTitle({ ...params, userMessage: sourceText });
  return attempt.kind === "persisted";
}

export async function maybeGenerateSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  currentUserMessage?: string;
  userMessage: string;
  titleGeneration?: Promise<string | null>;
}): Promise<SessionTitleAttempt> {
  if (hasExplicitSessionName(params.entry) || params.entry?.sessionId !== params.sessionId) {
    return { kind: "skipped" };
  }

  const requestKey = `${params.storePath}\0${params.sessionKey}\0${params.sessionId}`;
  const existing = sessionTitleRequests.get(requestKey);
  if (existing) {
    return { kind: "in-flight", settled: existing };
  }

  // A retry may be triggered by a later send or by discussion open. Always
  // title the session from its original user message when the transcript owns it.
  const transcriptSource = readSessionTitleFieldsFromTranscript({
    agentId: params.agentId,
    sessionEntry: params.entry,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  }).firstUserMessage;
  const transcriptText = transcriptSource
    ? stripInlineDirectiveTagsForDisplay(stripInboundMetadata(transcriptSource)).text.trim()
    : "";
  const currentText = params.currentUserMessage
    ? stripInlineDirectiveTagsForDisplay(params.currentUserMessage).text.trim()
    : "";
  // A first-turn transcript may win the persistence race before title work starts.
  // When it is the current turn, retain the supplied attachment-enriched source.
  const sourceText =
    !transcriptText || (currentText && currentText === transcriptText)
      ? params.userMessage.trim()
      : transcriptText;
  if (!sourceText) {
    return { kind: "skipped" };
  }

  const request = getOrCreatePromise(
    sessionTitleRequests,
    requestKey,
    async () => {
      const displayName = await (params.titleGeneration ??
        generateDashboardSessionTitle({
          cfg: params.cfg,
          agentId: params.agentId,
          entry: params.entry,
          userMessage: sourceText,
        }));
      if (!displayName) {
        return false;
      }

      let persisted = false;
      await updateSessionEntry(
        {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        (current) => {
          if (current.sessionId !== params.sessionId || hasExplicitSessionName(current)) {
            return null;
          }
          persisted = true;
          return { displayName };
        },
        { requireWriteSuccess: true },
      );
      return persisted;
    },
    { evictOnSettled: true },
  );
  return (await request) ? { kind: "persisted" } : { kind: "skipped" };
}
