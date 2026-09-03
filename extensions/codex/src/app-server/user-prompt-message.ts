import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";

type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;

function buildSenderLabel(params: {
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
}): string | undefined {
  const label = params.senderName ?? params.senderUsername ?? params.senderE164 ?? params.senderId;
  if (!label) {
    return undefined;
  }
  return !params.senderId || label.includes(params.senderId)
    ? label
    : `${label} (${params.senderId})`;
}

function buildFromPrepared(
  params: EmbeddedRunAttemptParams,
  preparedUserMessage: MirroredUserMessage | undefined,
): AgentMessage {
  const senderId = normalizeOptionalString(params.senderId);
  const senderName = normalizeOptionalString(params.senderName);
  const senderUsername = normalizeOptionalString(params.senderUsername);
  const senderE164 = normalizeOptionalString(params.senderE164);
  const senderLabel = buildSenderLabel({ senderId, senderName, senderUsername, senderE164 });
  const sourceChannel = normalizeOptionalString(
    params.inputProvenance?.sourceChannel ?? params.messageChannel ?? params.messageProvider,
  );
  const metadata = {
    timestamp: Date.now(),
    ...(params.inputProvenance ? { provenance: params.inputProvenance } : {}),
    ...(sourceChannel ? { sourceChannel } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
    ...(senderE164 ? { senderE164 } : {}),
    ...(senderLabel ? { senderLabel } : {}),
  };
  return {
    role: "user",
    ...metadata,
    ...(preparedUserMessage ?? { content: params.transcriptPrompt ?? params.prompt }),
  } as AgentMessage;
}

export function buildCodexUserPromptMessage(params: EmbeddedRunAttemptParams): AgentMessage {
  return buildFromPrepared(params, params.userTurnTranscriptRecorder?.message);
}

function buildCodexUpstreamPromptMessage(
  params: EmbeddedRunAttemptParams,
  identity: string,
  upstreamUserText?: string,
): AgentMessage {
  const message = attachCodexMirrorIdentity(buildCodexUserPromptMessage(params), identity);
  return upstreamUserText ? attachUpstreamUserText(message, upstreamUserText) : message;
}

export function promptSnapshot(
  params: EmbeddedRunAttemptParams,
  turnId: string,
  upstreamUserText?: string,
): AgentMessage[] {
  return params.suppressNextUserMessagePersistence
    ? []
    : [buildCodexUpstreamPromptMessage(params, `${turnId}:prompt`, upstreamUserText)];
}

export async function buildResolvedCodexUserPromptMessage(
  params: EmbeddedRunAttemptParams,
): Promise<AgentMessage> {
  const resolvedMessage = await params.userTurnTranscriptRecorder?.resolveMessage();
  return buildFromPrepared(params, resolvedMessage ?? params.userTurnTranscriptRecorder?.message);
}

export async function resolveFinalCodexMirrorMessages(params: {
  params: EmbeddedRunAttemptParams;
  messagesSnapshot: AgentMessage[];
  turnId: string;
}): Promise<AgentMessage[]> {
  if (
    params.params.suppressNextUserMessagePersistence ||
    !params.params.userTurnTranscriptRecorder
  ) {
    return params.messagesSnapshot;
  }
  const previousPrompt = params.messagesSnapshot.find((message) => message.role === "user");
  const resolvedBase = attachCodexMirrorIdentity(
    await buildResolvedCodexUserPromptMessage(params.params),
    `${params.turnId}:prompt`,
  );
  const upstreamUserText = readUpstreamUserText(previousPrompt);
  const resolvedPrompt = upstreamUserText
    ? attachUpstreamUserText(resolvedBase, upstreamUserText)
    : resolvedBase;
  const firstUserIndex = params.messagesSnapshot.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) {
    return [resolvedPrompt, ...params.messagesSnapshot];
  }
  const messages = params.messagesSnapshot.slice();
  messages[firstUserIndex] = resolvedPrompt;
  return messages;
}
