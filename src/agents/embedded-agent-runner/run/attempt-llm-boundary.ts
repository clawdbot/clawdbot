/**
 * Installs runtime-context and prompt-transform boundaries before LLM calls.
 */
import { stripInboundMetadata } from "../../../auto-reply/reply/strip-inbound-meta.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import { INTER_SESSION_PROMPT_PREFIX_BASE } from "../../../sessions/input-provenance.js";
import { hasPersistedMedia, MEDIA_ONLY_USER_TEXT } from "../../../sessions/user-turn-media.js";
import { buildLateMediaAttachedProjection } from "../../../sessions/user-turn-transcript.js";
import {
  resolveRuntimeContextPromptOwner,
  retainRuntimeContextMessageForPrompt,
  stripHistoricalRuntimeContextCustomMessages,
} from "../../internal-runtime-context.js";
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
} from "./attempt-history.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

type LlmBoundaryOptions = {
  appendOnlyRuntimeContext?: boolean;
  timezone?: string;
  includeTimestamp?: boolean;
  projectPersistedSenderContext?: boolean;
  userTranscriptContexts?: readonly UserTranscriptContext[];
  currentUserTimestampOverride?: CurrentUserTimestampMatch;
};

type PromptContextTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;

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
  const normalizedUserMessages = normalizeUserMessagesForLlmBoundary(normalized, options);
  const withPersistedSenderContext =
    options?.projectPersistedSenderContext === false
      ? normalizedUserMessages
      : projectPersistedSenderContext(normalizedUserMessages, userTranscriptMessages);
  // Prefix-bound thinking must replay every earlier carrier in its original position.
  return options?.appendOnlyRuntimeContext
    ? withPersistedSenderContext
    : stripHistoricalRuntimeContextCustomMessages(withPersistedSenderContext);
}

/** Normalizes existing transcript messages as if the current prompt were appended last. */
export function normalizeMessagesForCurrentPromptBoundary(params: {
  appendOnlyRuntimeContext?: boolean;
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
  appendOnlyRuntimeContext?: boolean;
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
  appendOnlyRuntimeContext?: boolean;
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
    appendOnlyRuntimeContext: params.appendOnlyRuntimeContext,
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
      transformContext?: PromptContextTransform;
    };
  };
  message?: RuntimeContextCustomMessage;
  persistedUserIdempotencyKey?: string;
}): () => void {
  const { message, session } = params;
  if (!message) {
    return () => undefined;
  }
  const owner = retainRuntimeContextMessageForPrompt(message);
  const install = (retry: boolean) => {
    const messages = session.messages;
    if (messages.includes(message)) {
      return;
    }
    const canonicalUser = owner.transcriptUser ?? owner.user;
    const canonicalKey =
      typeof canonicalUser === "object" && canonicalUser !== null
        ? Reflect.get(canonicalUser, "idempotencyKey")
        : undefined;
    const userIdempotencyKey =
      owner.transcriptUser === undefined
        ? (params.persistedUserIdempotencyKey ?? canonicalKey)
        : canonicalKey;
    const userIndex = userIdempotencyKey
      ? messages.findIndex(
          (candidate) =>
            candidate.role === "user" &&
            Reflect.get(candidate, "idempotencyKey") === userIdempotencyKey,
        )
      : owner.user
        ? messages.findIndex(
            (candidate) => candidate === owner.user || candidate === owner.transcriptUser,
          )
        : retry
          ? findActiveUserMessageIndex(messages)
          : -1;
    // Compaction restores canonical transcript objects. Keep the original user's
    // recorded key/reference; never attach its context to a later steering user.
    if (retry && userIndex < 0) {
      return;
    }
    const index = userIndex < 0 ? messages.length : userIndex;
    session.agent.state.messages = [...messages.slice(0, index), message, ...messages.slice(index)];
  };
  install(false);
  const agent = session.agent;
  const originalTransformContext = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    // Capture source identity before prompt hooks and replay sanitizers clone it.
    owner.user ??= messages[resolveRuntimeContextPromptOwner(messages)?.userIndex ?? -1];
    return originalTransformContext
      ? await originalTransformContext.call(agent, messages, signal)
      : messages;
  };
  const originalContinue = Reflect.get(agent, "continue", agent) as unknown;
  if (typeof originalContinue === "function") {
    const continueWithAgent = originalContinue.bind(agent) as () => Promise<void>;
    agent.continue = function continueWithRuntimeContext(this: typeof agent): Promise<void> {
      // Pi overflow recovery can rebuild state from the persisted branch before retrying.
      install(true);
      return continueWithAgent();
    };
  }
  return () => {
    owner.release();
    agent.transformContext = originalTransformContext;
    if (typeof originalContinue === "function") {
      agent.continue = originalContinue as typeof agent.continue;
    }
    session.agent.state.messages = session.messages.filter((candidate) => candidate !== message);
  };
}

function replaceUserTextPrompt(params: {
  messages: AgentMessage[];
  userIndex: number;
  transcriptText?: string;
  replace: (text: string) => string | undefined;
}): AgentMessage[] {
  const { userIndex } = params;
  const message = params.messages[userIndex];
  if (!message || message.role !== "user") {
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
      transformContext?: PromptContextTransform;
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
  let targetPrompt: AgentMessage | undefined;
  let promptOwner:
    | NonNullable<ReturnType<typeof resolveRuntimeContextPromptOwner>>["owner"]
    | undefined;
  agent.transformContext = async (messages, signal) => {
    if (!targetPrompt && params.shouldCapturePrompt()) {
      targetPrompt = messages[findActiveUserMessageIndex(messages)];
      const retainedOwner = resolveRuntimeContextPromptOwner(messages)?.owner;
      if (retainedOwner?.user === targetPrompt) {
        promptOwner = retainedOwner;
      }
    }
    const canonicalPrompt = promptOwner?.transcriptUser ?? targetPrompt;
    const key =
      typeof canonicalPrompt === "object" && canonicalPrompt !== null
        ? Reflect.get(canonicalPrompt, "idempotencyKey")
        : undefined;
    let userIndex = messages.findIndex(
      (message) => message === targetPrompt || message === canonicalPrompt,
    );
    if (userIndex < 0 && key) {
      userIndex = messages.findIndex(
        (message) => message.role === "user" && Reflect.get(message, "idempotencyKey") === key,
      );
    }
    // Carrierless keyless transcript replay has no retained canonical reference.
    // Preserve its timestamp match only when unique; a known owner never adopts
    // a later user after compaction removes the original prompt.
    if (userIndex < 0 && targetPrompt && !promptOwner && !key) {
      const timestamp = Reflect.get(targetPrompt, "timestamp");
      const matches = messages.flatMap((message, index) =>
        message.role === "user" &&
        typeof timestamp === "number" &&
        Reflect.get(message, "timestamp") === timestamp
          ? [index]
          : [],
      );
      userIndex = matches.length === 1 ? (matches[0] ?? -1) : -1;
    }
    const promptMessages = replaceUserTextPrompt({
      messages,
      userIndex,
      transcriptText: params.transcriptPrompt,
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

function normalizeUserMessagesForLlmBoundary(
  messages: AgentMessage[],
  options: LlmBoundaryOptions | undefined,
): AgentMessage[] {
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  const prompt = resolveRuntimeContextPromptOwner(messages);
  const promptUserMessageIndex = prompt?.userIndex ?? -1;
  if (prompt) {
    // The persistence owner already records this exact pair, including keyless
    // users and write-hook replacements. Retain it for same-attempt compaction.
    prompt.owner.transcriptUser =
      options?.userTranscriptContexts?.find(
        (context) => context.runtimeMessage === prompt.owner.user,
      )?.transcriptMessage ?? prompt.owner.transcriptUser;
  }
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user") {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const injectMediaText = !hasNonBlankUserText(content) && hasPersistedMedia(message);
    const isActive =
      index === activeUserMessageIndex ||
      (promptUserMessageIndex >= 0 && index >= promptUserMessageIndex);
    const preserveInboundMetadata = isActive || options?.appendOnlyRuntimeContext === true;
    const override = options?.currentUserTimestampOverride;
    const runtimeTimestamp = (message as { timestamp?: unknown }).timestamp;
    const useCurrentUserTimestampOverride =
      override !== undefined &&
      (isActive ||
        (typeof override.runtimeTimestamp === "number" &&
          override.runtimeTimestamp === runtimeTimestamp)) &&
      messageContentMatchesCurrentUserText(content, override) &&
      messageRuntimeTimestampMatchesCurrentUserOverride(runtimeTimestamp, override);
    const messageTimestamp = useCurrentUserTimestampOverride
      ? override.timestamp
      : runtimeTimestamp;

    // Append-only replay keeps historical metadata because removing it invalidates
    // later thinking signatures. Timestamp envelopes remain fixed in both policies.
    const transformText = (raw: string): string => {
      // Restore late-media paths only for blank media turns, never into transcript storage.
      const sourceText =
        injectMediaText && !raw.trim()
          ? (buildLateMediaAttachedProjection(message).text ?? MEDIA_ONLY_USER_TEXT)
          : raw;
      const { body, envelope } = splitLeadingTimestampEnvelope(sourceText);
      if (envelope || sourceText.includes(BOUNDARY_CRON_TIME_MARKER)) {
        if (preserveInboundMetadata) {
          return sourceText;
        }
        // Strip metadata from the body but re-attach the original envelope.
        return `${envelope}${stripInboundMetadata(body)}`;
      }
      const stripped = preserveInboundMetadata ? sourceText : stripInboundMetadata(sourceText);
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
        nextText = preserveInboundMetadata ? textBlock.text : stripInboundMetadata(textBlock.text);
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
    const openclaw = Reflect.get(message, "__openclaw");
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
    return Object.assign({}, message, {
      __openclaw: nextOpenClaw,
    });
  });
  return changed ? nextMessages : messages;
}
