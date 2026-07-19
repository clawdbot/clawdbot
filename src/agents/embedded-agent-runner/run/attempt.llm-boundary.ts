/**
 * Installs runtime-context and prompt-transform boundaries before LLM calls.
 */
import { stripInboundMetadata } from "../../../auto-reply/reply/strip-inbound-meta.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import { INTER_SESSION_PROMPT_PREFIX_BASE } from "../../../sessions/input-provenance.js";
import { hasPersistedMedia, MEDIA_ONLY_USER_TEXT } from "../../../sessions/user-turn-media.js";
import { buildLateMediaAttachedText } from "../../../sessions/user-turn-transcript.js";
import { stripHistoricalRuntimeContextCustomMessages } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { stripToolResultDetails } from "../../session-transcript-repair.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import { markTranscriptPromptText } from "../tool-result-context-guard.js";
import {
  findActiveUserMessageIndex,
  hasNonBlankUserText,
  projectPersistedSenderContext,
  readFirstUserText,
  resolveUserTranscriptMessages,
  splitLeadingTimestampEnvelope,
  type CurrentUserTimestampMatch,
  type UserTranscriptContext,
} from "./attempt.user-message-boundary.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

type LlmBoundaryOptions = {
  timezone?: string;
  includeTimestamp?: boolean;
  projectPersistedSenderContext?: boolean;
  userTranscriptContexts?: readonly UserTranscriptContext[];
  currentUserTimestampOverride?: CurrentUserTimestampMatch;
};

/**
 * Matches a leading `[... YYYY-MM-DD HH:MM ...]` timestamp envelope — either
 * from a channel plugin envelope or from a previous boundary stamp. Mirrors
 * TIMESTAMP_ENVELOPE_PATTERN in agent-timestamp.ts. Used to avoid
 * double-stamping a user message that already carries a timestamp.
 */
const BOUNDARY_TIMESTAMP_ENVELOPE_RE = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
const BOUNDARY_CRON_TIME_MARKER = "Current time: ";

export function normalizeMessagesForLlmBoundary(
  messages: AgentMessage[],
  options?: LlmBoundaryOptions,
): AgentMessage[] {
  const normalized = stripUnsafeBlockedRunMetadata(
    stripToolResultDetails(normalizeAssistantReplayContent(messages)),
  );
  const userTranscriptMessages = resolveUserTranscriptMessages(
    normalized,
    options?.userTranscriptContexts,
    options?.currentUserTimestampOverride,
  );
  const withoutHistoricalInboundMetadata = stripHistoricalInboundMetadataFromUserMessages(
    normalized,
    options,
  );
  const withPersistedSenderContext =
    options?.projectPersistedSenderContext === false
      ? withoutHistoricalInboundMetadata
      : projectPersistedSenderContext(withoutHistoricalInboundMetadata, userTranscriptMessages);
  return stripHistoricalRuntimeContextCustomMessages(withPersistedSenderContext);
}

/** Normalizes existing transcript messages as if the current prompt were appended last. */
export function normalizeMessagesForCurrentPromptBoundary(params: {
  messages: AgentMessage[];
  prompt: string;
  timezone?: string;
  includeTimestamp?: boolean;
  currentUserTimestamp?: number;
}): AgentMessage[] {
  const { message, options } = buildCurrentPromptBoundaryInput(params);
  return normalizeMessagesForLlmBoundary([...params.messages, message], options).slice(0, -1);
}

export function normalizeCurrentPromptTextForLlmBoundary(params: {
  prompt: string;
  timezone?: string;
  includeTimestamp?: boolean;
  currentUserTimestamp?: number;
  currentUserTranscriptMessage?: AgentMessage;
}): string {
  const { message, options } = buildCurrentPromptBoundaryInput(params);
  const [normalized] = normalizeMessagesForLlmBoundary([message], options);
  const content = (normalized as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : params.prompt;
}

function buildCurrentPromptBoundaryInput(params: {
  prompt: string;
  timezone?: string;
  includeTimestamp?: boolean;
  currentUserTimestamp?: number;
  currentUserTranscriptMessage?: AgentMessage;
}): { message: AgentMessage; options?: LlmBoundaryOptions } {
  const message = {
    role: "user",
    content: [{ type: "text", text: params.prompt }],
    timestamp: params.currentUserTimestamp ?? Date.now(),
  } as AgentMessage;
  const options: LlmBoundaryOptions = {
    ...(params.timezone ? { timezone: params.timezone } : {}),
    ...(params.includeTimestamp === false ? { includeTimestamp: false } : {}),
    ...(params.currentUserTranscriptMessage
      ? {
          userTranscriptContexts: [
            {
              runtimeMessage: message,
              transcriptMessage: params.currentUserTranscriptMessage,
            },
          ],
        }
      : {}),
  };
  return { message, options };
}

/**
 * Temporarily injects a runtime-context message for prompt conversion and retry.
 * Cleanup restores the original continuation hook and removes only the injected
 * message object.
 */
export function installRuntimeContextMessageForPrompt(params: {
  session: {
    messages: AgentMessage[];
    agent: {
      state: { messages: AgentMessage[] };
      continue?: () => Promise<void>;
    };
  };
  message?: RuntimeContextCustomMessage;
}): () => void {
  const { message, session } = params;
  if (!message) {
    return () => undefined;
  }
  const installBeforePrompt = () => {
    if (!session.messages.includes(message)) {
      session.agent.state.messages = appendRuntimeContextMessageForPrompt({
        message,
        messages: session.messages,
      });
    }
  };
  const installBeforeRetry = () => {
    if (!session.messages.includes(message)) {
      session.agent.state.messages = insertRuntimeContextMessageForPrompt({
        message,
        messages: session.messages,
      });
    }
  };
  installBeforePrompt();
  const agent = session.agent;
  const originalContinue = Reflect.get(agent, "continue", agent) as unknown;
  if (typeof originalContinue === "function") {
    const continueWithAgent = originalContinue.bind(agent) as () => Promise<void>;
    agent.continue = function continueWithRuntimeContext(this: typeof agent): Promise<void> {
      // Pi overflow recovery can rebuild state from the persisted branch before retrying.
      installBeforeRetry();
      return continueWithAgent();
    };
  }
  return () => {
    if (typeof originalContinue === "function") {
      agent.continue = originalContinue as typeof agent.continue;
    }
    session.agent.state.messages = session.messages.filter((candidate) => candidate !== message);
  };
}

function appendRuntimeContextMessageForPrompt(params: {
  message: RuntimeContextCustomMessage;
  messages: AgentMessage[];
}): AgentMessage[] {
  if (params.messages.includes(params.message)) {
    return params.messages;
  }
  return [...params.messages, params.message];
}

/**
 * Inserts runtime context before the active user turn on retry. Overflow rebuilds
 * can rehydrate a transcript ending in tool-call messages, so the active prompt
 * is found by walking backward through tool-call assistants.
 */
function insertRuntimeContextMessageForPrompt(params: {
  message: RuntimeContextCustomMessage;
  messages: AgentMessage[];
}): AgentMessage[] {
  if (params.messages.includes(params.message)) {
    return params.messages;
  }
  const activeUserMessageIndex = findActiveUserMessageIndex(params.messages);
  if (activeUserMessageIndex === -1) {
    return [...params.messages, params.message];
  }
  return [
    ...params.messages.slice(0, activeUserMessageIndex),
    params.message,
    ...params.messages.slice(activeUserMessageIndex),
  ];
}

function replaceLastUserTextPrompt(params: {
  messages: AgentMessage[];
  shouldCapture?: (message: AgentMessage) => boolean;
  transcriptText?: string;
  replace: (text: string) => string | undefined;
}): AgentMessage[] {
  const userIndex = params.messages.findLastIndex((message) => message.role === "user");
  if (userIndex === -1) {
    return params.messages;
  }
  const message = params.messages[userIndex];
  if (!message || message.role !== "user") {
    return params.messages;
  }
  if (params.shouldCapture && !params.shouldCapture(message)) {
    return params.messages;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const replacement = params.replace(content);
    if (replacement === undefined) {
      return params.messages;
    }
    const next = params.messages.slice();
    next[userIndex] = { ...message, content: replacement } as AgentMessage;
    if (params.transcriptText !== undefined) {
      markTranscriptPromptText(next[userIndex], params.transcriptText);
    }
    return next;
  }
  if (!Array.isArray(content)) {
    return params.messages;
  }
  let replaced = false;
  const nextContent = content.map((block) => {
    if (replaced || !block || typeof block !== "object") {
      return block;
    }
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
      return block;
    }
    const replacement = params.replace(textBlock.text);
    if (replacement === undefined) {
      return block;
    }
    replaced = true;
    return Object.assign({}, block, { text: replacement });
  });
  if (!replaced) {
    return params.messages;
  }
  const next = params.messages.slice();
  next[userIndex] = { ...message, content: nextContent } as AgentMessage;
  if (params.transcriptText !== undefined) {
    markTranscriptPromptText(next[userIndex], params.transcriptText);
  }
  return next;
}

function composeModelPromptContext(params: {
  prompt: string;
  prependContext?: string;
  appendContext?: string;
}): string {
  return [params.prependContext, params.prompt, params.appendContext]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

/**
 * Temporarily rewrites only the active user prompt for model submission while
 * preserving the transcript prompt text for repair/guard metadata.
 */
export function installModelPromptTransform(params: {
  session: {
    agent: {
      transformContext?: (
        messages: AgentMessage[],
        signal?: AbortSignal,
      ) => Promise<AgentMessage[]>;
    };
  };
  transcriptPrompt: string;
  modelPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  shouldCapturePrompt: () => boolean;
}): () => void {
  const modelPrompt = params.modelPrompt;
  const hasPromptContext =
    Boolean(params.prependContext?.trim()) || Boolean(params.appendContext?.trim());
  if ((!modelPrompt?.trim() || modelPrompt === params.transcriptPrompt) && !hasPromptContext) {
    return () => undefined;
  }
  const agent = params.session.agent;
  const originalTransformContext = agent.transformContext;
  let targetPromptTimestamp: number | undefined;
  agent.transformContext = async (messages, signal) => {
    const promptMessages = replaceLastUserTextPrompt({
      messages,
      transcriptText: params.transcriptPrompt,
      shouldCapture: (message) => {
        const timestamp = (message as { timestamp?: unknown }).timestamp;
        if (targetPromptTimestamp !== undefined) {
          return timestamp === targetPromptTimestamp;
        }
        if (!params.shouldCapturePrompt()) {
          return false;
        }
        if (typeof timestamp === "number") {
          targetPromptTimestamp = timestamp;
        }
        return true;
      },
      replace: (text) => {
        if (modelPrompt?.trim() && text === params.transcriptPrompt) {
          return modelPrompt;
        }
        if (!hasPromptContext) {
          return undefined;
        }
        const replacement = composeModelPromptContext({
          prompt: text,
          prependContext: params.prependContext,
          appendContext: params.appendContext,
        });
        return replacement === text ? undefined : replacement;
      },
    });
    return originalTransformContext
      ? await originalTransformContext.call(agent, promptMessages, signal)
      : promptMessages;
  };
  return () => {
    agent.transformContext = originalTransformContext;
  };
}

/**
 * Collapse a single-text-block content array to a plain string.
 *
 * Full-resend transports (anthropic-messages, openai-completions) re-send the
 * entire message history every turn.  The CURRENT user turn arrives as an
 * array `[{type:"text", text:"…"}]` (the SDK's native format), while
 * historical turns are loaded from the JSONL transcript as a plain string.
 * This form flip alone busts the prompt cache even when the text is identical.
 *
 * Collapsing single-text-block arrays to strings makes the serialized bytes
 * identical whether a message is current or historical.
 *
 * Turns with attachments (image / document blocks) must remain as arrays and
 * are NOT collapsed.
 *
 * @see https://github.com/openclaw/openclaw/issues/3658
 */
function canonicalizeTextOnlyUserContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  // Only collapse when there is exactly one block and it is a text block.
  if (content.length !== 1) {
    return content;
  }
  const block = content[0];
  if (!block || typeof block !== "object") {
    return content;
  }
  const textBlock = block as { type?: unknown; text?: unknown };
  if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
    return content;
  }
  // Attachment turns legitimately need block arrays — if there is any
  // non-text block alongside this one, keep the array form.  (Single-element
  // check above already handles the common case; this guard is for safety.)
  return textBlock.text;
}

/**
 * Stamp a bare text string with this message's own timestamp prefix.
 *
 * SINGLE SOURCE OF TRUTH for the per-message `[DOW YYYY-MM-DD HH:MM TZ]`
 * prefix (issue #3658). The gateway no longer stamps the live turn, and
 * storage is bare — so every user message (current AND historical) is stamped
 * HERE from its OWN `timestamp` field. Because the stamp derives from the
 * message's fixed timestamp (NOT wall-clock `now`), the SAME message produces
 * byte-identical bytes whether it is sent as the current turn or replayed as
 * history. That stability is what lets full-resend transports cache the prefix.
 *
 * Guards (return text unchanged):
 *  - empty / whitespace-only text;
 *  - text already carrying a `[... YYYY-MM-DD HH:MM ...]` envelope (channel
 *    plugin envelope or an already-applied stamp);
 *  - cron messages carrying the "Current time: " marker.
 */
function stampUserTextWithMessageTimestamp(
  text: string,
  timestamp: unknown,
  timezone: string | undefined,
  includeTimestamp: boolean | undefined,
): string {
  // Stamping is opt-in: only the LLM-boundary call sites that pass a resolved
  // timezone (via resolveUserTimezone) stamp messages. When no timezone is
  // supplied, the boundary performs form/metadata normalization only — leaving
  // content bare (this also keeps non-stamping callers and unit fixtures clean).
  if (includeTimestamp === false) {
    return text;
  }
  if (!timezone) {
    return text;
  }
  if (!text.trim()) {
    return text;
  }
  if (BOUNDARY_TIMESTAMP_ENVELOPE_RE.test(text) || text.includes(BOUNDARY_CRON_TIME_MARKER)) {
    return text;
  }
  if (text.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE)) {
    return text;
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return text;
  }
  const prefix = buildTimestampPrefix(new Date(timestamp), { timezone });
  if (!prefix) {
    return text;
  }
  return `${prefix}${text}`;
}

function messageContentMatchesCurrentUserText(
  content: unknown,
  override: NonNullable<LlmBoundaryOptions["currentUserTimestampOverride"]>,
): boolean {
  const matchesText = (text: string): boolean =>
    text === override.text || text === override.alternateText;
  const text = readFirstUserText(content);
  return text !== undefined && matchesText(text);
}

function messageRuntimeTimestampMatchesCurrentUserOverride(
  runtimeTimestamp: unknown,
  override: NonNullable<LlmBoundaryOptions["currentUserTimestampOverride"]>,
): boolean {
  if (typeof override.runtimeTimestamp === "number") {
    return runtimeTimestamp === override.runtimeTimestamp;
  }
  if (typeof runtimeTimestamp === "number" && Number.isFinite(runtimeTimestamp)) {
    override.runtimeTimestamp = runtimeTimestamp;
  }
  return true;
}

function stripHistoricalInboundMetadataFromUserMessages(
  messages: AgentMessage[],
  options: LlmBoundaryOptions | undefined,
): AgentMessage[] {
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user") {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const injectMediaText = hasPersistedMedia(message) && !hasNonBlankUserText(content);
    // #111204: restore marked path lines here, never in UI-visible transcript storage.
    const mediaOnlyText = buildLateMediaAttachedText(message) ?? MEDIA_ONLY_USER_TEXT;
    const isActive = index === activeUserMessageIndex;
    const override = options?.currentUserTimestampOverride;
    const runtimeTimestamp = (message as { timestamp?: unknown }).timestamp;
    const useCurrentUserTimestampOverride =
      isActive &&
      override !== undefined &&
      messageContentMatchesCurrentUserText(content, override) &&
      messageRuntimeTimestampMatchesCurrentUserOverride(runtimeTimestamp, override);
    const messageTimestamp = useCurrentUserTimestampOverride
      ? override.timestamp
      : runtimeTimestamp;

    // Historical turns strip inbound metadata blocks (Conversation info, Sender
    // info, etc.); the active turn keeps its metadata for the current request.
    // BOTH then get media-only text if needed, form-canonicalize, and stamp from
    // their own timestamp, so current and historical bytes stay identical.
    //
    // Channel-envelope preservation: a message that already carries its OWN
    // leading `[DOW YYYY-MM-DD HH:MM ...] ` envelope (Discord/Telegram, or a
    // cron "Current time:" marker) keeps it verbatim — we strip metadata from
    // the body but NEVER drop or replace the envelope, and never re-stamp. This
    // keeps such messages byte-stable across current↔historical (the envelope is
    // present in both forms) and avoids double-stamping.
    const transformText = (raw: string): string => {
      const sourceText = injectMediaText && !raw.trim() ? mediaOnlyText : raw;
      const { body, envelope } = splitLeadingTimestampEnvelope(sourceText);
      if (envelope || sourceText.includes(BOUNDARY_CRON_TIME_MARKER)) {
        if (isActive) {
          return sourceText;
        }
        // Strip metadata from the body but re-attach the original envelope.
        return `${envelope}${stripInboundMetadata(body)}`;
      }
      const stripped = isActive ? sourceText : stripInboundMetadata(sourceText);
      return stampUserTextWithMessageTimestamp(
        stripped,
        messageTimestamp,
        options?.timezone,
        options?.includeTimestamp,
      );
    };

    if (typeof content === "string") {
      const next = transformText(content);
      if (next === content) {
        return message;
      }
      changed = true;
      return { ...message, content: next } as AgentMessage;
    }

    if (!Array.isArray(content)) {
      return message;
    }

    // Collapse a single-text-block array to a plain string first so text-only
    // turns serialize identically to their stored (string) historical form;
    // attachment/multi-block turns stay arrays and are stamped in-block.
    const canonical = canonicalizeTextOnlyUserContent(content);
    if (typeof canonical === "string") {
      // The array→string collapse alone is a content change, so this message
      // is always rewritten (text additionally stripped/stamped via transformText).
      changed = true;
      return { ...message, content: transformText(canonical) } as AgentMessage;
    }

    // Multi-block / non-text content (attachment turns): the FIRST text block is
    // strip+stamped via transformText (envelope-aware, like the string path);
    // any subsequent text blocks are only metadata-stripped (historical) so a
    // single stamp labels the turn. Non-text blocks (images, documents) are
    // preserved untouched so attachment turns keep their array form.
    let contentChanged = false;
    let processedFirstText = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const textBlock = block as { type?: unknown; text?: unknown };
      if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
        return block;
      }
      let nextText: string;
      if (!processedFirstText) {
        nextText = transformText(textBlock.text);
        processedFirstText = true;
      } else {
        nextText = isActive ? textBlock.text : stripInboundMetadata(textBlock.text);
      }
      if (nextText === textBlock.text) {
        return block;
      }
      contentChanged = true;
      return Object.assign({}, block, { text: nextText });
    });
    if (!processedFirstText && injectMediaText) {
      nextContent.unshift({ type: "text", text: transformText("") });
      contentChanged = true;
    }
    if (!contentChanged) {
      return message;
    }
    changed = true;
    return { ...message, content: nextContent } as AgentMessage;
  });
  return changed ? nextMessages : messages;
}

function stripUnsafeBlockedRunMetadata(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    const openclaw = (message as unknown as Record<string, unknown>)["__openclaw"];
    if (!openclaw || typeof openclaw !== "object") {
      return message;
    }
    const beforeAgentRunBlocked = (openclaw as { beforeAgentRunBlocked?: unknown })
      .beforeAgentRunBlocked;
    if (!beforeAgentRunBlocked || typeof beforeAgentRunBlocked !== "object") {
      return message;
    }
    const blocked = beforeAgentRunBlocked as Record<string, unknown>;
    const safeBlocked: Record<string, unknown> = {};
    if (typeof blocked.blockedBy === "string") {
      safeBlocked.blockedBy = blocked.blockedBy;
    }
    if (typeof blocked.blockedAt === "number") {
      safeBlocked.blockedAt = blocked.blockedAt;
    }
    const nextOpenClaw = {
      ...(openclaw as Record<string, unknown>),
      beforeAgentRunBlocked: safeBlocked,
    };
    changed = true;
    return {
      ...(message as unknown as Record<string, unknown>),
      __openclaw: nextOpenClaw,
    } as unknown as AgentMessage;
  });
  return changed ? nextMessages : messages;
}
