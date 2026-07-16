import { formatUntrustedJsonBlock } from "../../../auto-reply/reply/untrusted-context.js";
import {
  hasInterSessionUserProvenance,
  INTER_SESSION_PROMPT_PREFIX_BASE,
} from "../../../sessions/input-provenance.js";
import type { AgentMessage } from "../../runtime/index.js";
import { stableStringify } from "../../stable-stringify.js";
import { isRunnerToolCallBlockType } from "./attempt.tool-call-block-type.js";

export type UserTranscriptContext = {
  runtimeMessage: AgentMessage;
  transcriptMessage: AgentMessage;
};

export type CurrentUserTimestampMatch = {
  timestamp: number;
  text: string;
  alternateText?: string;
  runtimeTimestamp?: number;
};

// Mirrors LEADING_TIMESTAMP_PREFIX_RE in strip-inbound-meta.ts so sender
// projection never displaces or duplicates a cache-stable timestamp envelope.
const LEADING_TIMESTAMP_ENVELOPE_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const CONVERSATION_INFO_LABEL = "Conversation info (untrusted metadata):";

export function splitLeadingTimestampEnvelope(text: string): {
  body: string;
  envelope: string;
} {
  const envelope = text.match(LEADING_TIMESTAMP_ENVELOPE_RE)?.[0] ?? "";
  return { envelope, body: envelope ? text.slice(envelope.length) : text };
}

export function readFirstUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const firstTextBlock = content.find((block): block is { text: string; type?: unknown } => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    return typedBlock.type === "text" && typeof typedBlock.text === "string";
  });
  return firstTextBlock?.text;
}

function contentMatchesTimestampOverride(
  content: unknown,
  override: CurrentUserTimestampMatch,
): boolean {
  const text = readFirstUserText(content);
  return text !== undefined && (text === override.text || text === override.alternateText);
}

export function resolveUserTranscriptMessages(
  messages: AgentMessage[],
  contexts: readonly UserTranscriptContext[] | undefined,
  override: CurrentUserTimestampMatch | undefined,
): Array<AgentMessage | undefined> {
  const resolved = Array.from(
    { length: messages.length },
    () => undefined as AgentMessage | undefined,
  );
  if (!contexts?.length) {
    return resolved;
  }
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  const unusedContexts = new Set(contexts);
  // Reserve object-identity matches before structural fallback so duplicate
  // timestamp/text turns cannot consume a later message's exact pairing.
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }
    const context = [...unusedContexts].find((candidate) => candidate.runtimeMessage === message);
    if (!context) {
      continue;
    }
    resolved[index] = context.transcriptMessage;
    unusedContexts.delete(context);
  }
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || resolved[index]) {
      continue;
    }
    const context = [...unusedContexts].find((candidate) =>
      userMessageMatchesTranscriptContext(
        message,
        candidate,
        index === activeUserMessageIndex ? override : undefined,
      ),
    );
    if (!context) {
      continue;
    }
    resolved[index] = context.transcriptMessage;
    unusedContexts.delete(context);
  }
  return resolved;
}

function userMessageMatchesTranscriptContext(
  message: AgentMessage,
  context: UserTranscriptContext,
  override: CurrentUserTimestampMatch | undefined,
): boolean {
  if (message === context.runtimeMessage) {
    return true;
  }
  const messageTimestamp = (message as { timestamp?: unknown }).timestamp;
  const runtimeTimestamp = (context.runtimeMessage as { timestamp?: unknown }).timestamp;
  if (
    typeof messageTimestamp !== "number" ||
    !Number.isFinite(messageTimestamp) ||
    messageTimestamp !== runtimeTimestamp
  ) {
    return false;
  }
  const messageContent = (message as { content?: unknown }).content;
  const runtimeContent = (context.runtimeMessage as { content?: unknown }).content;
  const messageText = readFirstUserText(messageContent);
  const runtimeText = readFirstUserText(runtimeContent);
  if (messageText !== undefined && messageText === runtimeText) {
    return true;
  }
  if (
    messageText === undefined &&
    runtimeText === undefined &&
    Array.isArray(messageContent) &&
    Array.isArray(runtimeContent) &&
    stableStringify(messageContent) === stableStringify(runtimeContent)
  ) {
    return true;
  }
  return Boolean(
    override &&
    contentMatchesTimestampOverride(messageContent, override) &&
    contentMatchesTimestampOverride(runtimeContent, override),
  );
}

function normalizePersistedSenderValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replaceAll("\u0000", "").trim();
  return normalized || undefined;
}

type PersistedSender = {
  id?: string;
  name?: string;
  username?: string;
};

function readPersistedSender(message: AgentMessage): PersistedSender | undefined {
  const openclaw = (message as unknown as Record<string, unknown>)["__openclaw"];
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const meta = openclaw as Record<string, unknown>;
  const sender = {
    id: normalizePersistedSenderValue(meta["senderId"]),
    name: normalizePersistedSenderValue(meta["senderName"]),
    username: normalizePersistedSenderValue(meta["senderUsername"]),
  };
  if (Object.values(sender).every((value) => value === undefined)) {
    return undefined;
  }
  return sender;
}

function formatPersistedSenderContext(sender: PersistedSender): string {
  return formatUntrustedJsonBlock(CONVERSATION_INFO_LABEL, { sender });
}

function mergeSenderIntoLeadingConversationInfo(
  text: string,
  sender: PersistedSender,
): string | undefined {
  const { body, envelope } = splitLeadingTimestampEnvelope(text);
  const jsonPrefix = `${CONVERSATION_INFO_LABEL}\n\`\`\`json\n`;
  if (!body.startsWith(jsonPrefix)) {
    return undefined;
  }
  const jsonEnd = body.indexOf("\n```", jsonPrefix.length);
  if (jsonEnd === -1) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.slice(jsonPrefix.length, jsonEnd));
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const suffix = body.slice(jsonEnd + "\n```".length);
  return `${envelope}${formatUntrustedJsonBlock(CONVERSATION_INFO_LABEL, {
    ...(payload as Record<string, unknown>),
    sender,
  })}${suffix}`;
}

function prependContextToUserMessage(message: AgentMessage, sender: PersistedSender): AgentMessage {
  const context = formatPersistedSenderContext(sender);
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const { body, envelope } = splitLeadingTimestampEnvelope(content);
    if (body === context || body.startsWith(`${context}\n\n`)) {
      return message;
    }
    const merged = mergeSenderIntoLeadingConversationInfo(content, sender);
    if (merged !== undefined) {
      return merged === content ? message : ({ ...message, content: merged } as AgentMessage);
    }
    return {
      ...message,
      content: `${envelope}${body ? `${context}\n\n${body}` : context}`,
    } as AgentMessage;
  }
  if (!Array.isArray(content)) {
    return message;
  }

  const textIndex = content.findIndex((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const textBlock = block as { type?: unknown; text?: unknown };
    return textBlock.type === "text" && typeof textBlock.text === "string";
  });
  if (textIndex === -1) {
    return {
      ...message,
      content: [{ type: "text", text: context }, ...content],
    } as AgentMessage;
  }
  const textBlock = content[textIndex] as { text: string };
  const { body, envelope } = splitLeadingTimestampEnvelope(textBlock.text);
  if (body === context || body.startsWith(`${context}\n\n`)) {
    return message;
  }
  const merged = mergeSenderIntoLeadingConversationInfo(textBlock.text, sender);
  const nextContent = content.slice();
  nextContent[textIndex] = {
    ...textBlock,
    text: merged ?? `${envelope}${body ? `${context}\n\n${body}` : context}`,
  };
  return { ...message, content: nextContent } as AgentMessage;
}

function hasInterSessionPromptPrefix(message: AgentMessage): boolean {
  const text = readFirstUserText((message as { content?: unknown }).content);
  if (text === undefined) {
    return false;
  }
  return splitLeadingTimestampEnvelope(text).body.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE);
}

export function projectPersistedSenderContext(
  messages: AgentMessage[],
  transcriptMessages?: readonly (AgentMessage | undefined)[],
): AgentMessage[] {
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user") {
      return message;
    }
    const transcriptMessage = transcriptMessages?.[index] ?? message;
    // Inter-session provenance must remain the first model-facing safety text.
    // Its own source envelope already identifies the routed origin.
    if (
      hasInterSessionUserProvenance(message) ||
      hasInterSessionUserProvenance(transcriptMessage) ||
      hasInterSessionPromptPrefix(message) ||
      hasInterSessionPromptPrefix(transcriptMessage)
    ) {
      return message;
    }
    // Group/channel persistence is the product boundary that opts into these
    // existing sender fields. Project every turn, including the active one, so
    // provider bytes stay stable when that same turn becomes historical.
    const sender = readPersistedSender(transcriptMessage);
    if (!sender) {
      return message;
    }
    const nextMessage = prependContextToUserMessage(message, sender);
    changed ||= nextMessage !== message;
    return nextMessage;
  });
  return changed ? nextMessages : messages;
}

export function findActiveUserMessageIndex(messages: AgentMessage[]): number {
  // A prompt turn may be followed by assistant tool-call scaffolding during
  // retry reconstruction. A normal assistant reply means the latest user turn is
  // historical, not the active prompt boundary.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      return index;
    }
    if (message.role === "assistant" && !isToolCallAssistantMessage(message)) {
      return -1;
    }
  }
  return -1;
}

function isToolCallAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return isRunnerToolCallBlockType(type);
  });
}
