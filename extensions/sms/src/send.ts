// Sms plugin module implements send behavior.
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import type { OutboundMediaLoadOptions } from "openclaw/plugin-sdk/outbound-media";
import {
  type MarkdownIR,
  renderMarkdownIRChunksWithinLimit,
  sanitizeAssistantVisibleText,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-chunking";
import { recordInitialSmsDeliveryResult } from "./delivery-observations.js";
import { getSmsRuntime } from "./runtime.js";
import { sendSmsViaTwilio, TWILIO_MESSAGE_BODY_MAX_LENGTH } from "./twilio.js";
import type { ResolvedSmsAccount, SmsSendResult } from "./types.js";

const SMS_ASSISTANT_TRANSCRIPT_ROLE_PREFIX = "[assistant-authored transcript] ";
type SmsMessageKind = "text" | "media";
type SmsDeliveryProgressResult = ChannelMessageSendResult & {
  channel: "sms";
  messageId: string;
  chatId: string;
};
type SmsDeliveryProgress = (result: SmsDeliveryProgressResult) => Promise<void> | void;

export type PreparedSmsMediaAttempt = {
  hostedMediaUrl: string;
  cleanupHostedMedia: () => Promise<void>;
  caption?: string;
  remainingChunks: readonly string[];
};

export function createSmsMessageReceipt(params: {
  results: SmsSendResult[];
  kind: SmsMessageKind;
}) {
  const receipt = createMessageReceiptFromOutboundResults({
    results: params.results.map((result) => ({
      channel: "sms",
      messageId: result.sid,
      chatId: result.to,
      toJid: result.to,
      conversationId: result.to,
      meta: {
        ...(result.from ? { from: result.from } : {}),
        ...(result.status ? { status: result.status } : {}),
      },
    })),
    threadId: params.results[0]?.to,
    kind: params.kind,
  });
  if (params.kind === "media") {
    receipt.parts = receipt.parts.map((part, index) =>
      index === 0 ? part : { ...part, kind: "text" },
    );
  }
  return receipt;
}

function createSmsDeliveryProgressResult(
  result: SmsSendResult,
  kind: SmsMessageKind,
): SmsDeliveryProgressResult {
  return {
    channel: "sms",
    messageId: result.sid,
    chatId: result.to,
    receipt: createSmsMessageReceipt({ results: [result], kind }),
  };
}

function throwSmsPartialDeliveryError(
  error: unknown,
  results: SmsSendResult[],
  kind: SmsMessageKind,
): never {
  if (results.length === 0) {
    throw error;
  }
  throw createChannelPartialDeliveryError(error, {
    messageIds: results.map((result) => result.sid),
    receipt: createSmsMessageReceipt({ results, kind }),
    visibleReplySent: true,
  });
}

export function toSmsPlainText(text: string): string {
  const visibleText = sanitizeAssistantVisibleText(text);
  return stripMarkdown(visibleText, {
    assistantTranscriptRoleHeaders: true,
    assistantTranscriptRolePrefix: SMS_ASSISTANT_TRANSCRIPT_ROLE_PREFIX,
    linkStyle: "label-and-url",
  })
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkSmsPlainText(text: string, limit: number): string[] {
  const ir: MarkdownIR = { text, styles: [], links: [] };
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    assistantTranscriptRoleMessageBoundaries: true,
    // A soft split can promote mid-line prose to a new SMS boundary. Re-run
    // the semantic annotation while measuring so the marker stays in-budget.
    renderChunk: (chunk) =>
      chunk.annotations?.some((annotation) => annotation.type === "assistant_transcript_role")
        ? `${SMS_ASSISTANT_TRANSCRIPT_ROLE_PREFIX}${chunk.text}`
        : chunk.text,
    measureRendered: (rendered) => rendered.length,
  })
    .map(({ rendered }) => rendered)
    .filter(Boolean);
}

function prepareSmsTextChunks(params: { text: string; configuredLimit: number }): string[] {
  const text = toSmsPlainText(params.text);
  if (!text) {
    return [];
  }
  return chunkSmsPlainText(text, Math.min(params.configuredLimit, TWILIO_MESSAGE_BODY_MAX_LENGTH));
}

async function sendSmsProviderMessage(params: {
  account: ResolvedSmsAccount;
  to: string;
  text?: string;
  mediaUrls?: readonly string[];
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<SmsSendResult> {
  let platformDispatchStarted = false;
  let result: SmsSendResult;
  try {
    result = await sendSmsViaTwilio({
      account: params.account,
      to: params.to,
      ...(params.text !== undefined ? { text: params.text } : {}),
      ...(params.mediaUrls !== undefined ? { mediaUrls: params.mediaUrls } : {}),
      onPlatformSendDispatch: async () => {
        // Twilio validates locally before this callback and performs HTTP after it.
        // Only failures before a persisted dispatch marker are proven safe to replay.
        await params.onPlatformSendDispatch?.();
        platformDispatchStarted = true;
      },
    });
  } catch (error) {
    if (platformDispatchStarted || error instanceof PlatformMessageNotDispatchedError) {
      throw error;
    }
    throw new PlatformMessageNotDispatchedError(
      `SMS send failed before Twilio dispatch: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  await recordInitialDeliveryBestEffort(params.account, result);
  return result;
}

function logInitialDeliveryPersistenceFailure(result: SmsSendResult, error: unknown): void {
  try {
    getSmsRuntime()
      .logging.getChildLogger({ plugin: "sms", feature: "delivery-status" })
      .warn("SMS delivery initial state could not be persisted.", {
        messageSid: result.sid,
        errorType: error instanceof Error ? error.name : typeof error,
      });
  } catch {
    // The provider send already succeeded; unavailable logging cannot turn
    // observation persistence into a resend or user-visible send failure.
  }
}

async function recordInitialDeliveryBestEffort(
  account: ResolvedSmsAccount,
  result: SmsSendResult,
): Promise<void> {
  try {
    await recordInitialSmsDeliveryResult({ account, result });
  } catch (error) {
    logInitialDeliveryPersistenceFailure(result, error);
  }
}

export async function sendSmsTextChunks(params: {
  account: ResolvedSmsAccount;
  to: string;
  text: string;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: SmsDeliveryProgress;
}): Promise<SmsSendResult[]> {
  const chunks = prepareSmsTextChunks({
    text: params.text,
    configuredLimit: params.account.textChunkLimit,
  });
  if (chunks.length === 0) {
    throw new Error("SMS send requires non-empty text.");
  }
  const results: SmsSendResult[] = [];
  try {
    for (const text of chunks) {
      const result = await sendSmsProviderMessage({
        account: params.account,
        to: params.to,
        text,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
      });
      results.push(result);
      await params.onDeliveryResult?.(createSmsDeliveryProgressResult(result, "text"));
    }
  } catch (error) {
    throwSmsPartialDeliveryError(error, results, "text");
  }
  return results;
}

export async function prepareSmsMediaAttempt(params: {
  account: ResolvedSmsAccount;
  text: string;
  mediaUrl: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<PreparedSmsMediaAttempt> {
  if (!params.mediaUrl) {
    throw new Error("MMS send requires mediaUrl.");
  }
  const chunks = prepareSmsTextChunks({
    text: params.text,
    configuredLimit: params.account.textChunkLimit,
  });
  const [caption, ...remainingChunks] = chunks;
  let hostedMedia: Pick<PreparedSmsMediaAttempt, "hostedMediaUrl" | "cleanupHostedMedia">;
  try {
    const { prepareHostedSmsMedia } = await import("./media.js");
    const prepared = await prepareHostedSmsMedia({
      account: params.account,
      mediaUrl: params.mediaUrl,
      mediaAccess: params.mediaAccess,
      mediaLocalRoots: params.mediaLocalRoots,
      mediaReadFile: params.mediaReadFile,
      captionByteLength: Buffer.byteLength(caption ?? "", "utf8"),
    });
    hostedMedia = {
      hostedMediaUrl: prepared.url,
      cleanupHostedMedia: prepared.cleanup,
    };
  } catch (error) {
    if (error instanceof PlatformMessageNotDispatchedError) {
      throw error;
    }
    // Hosting completes before Twilio's POST boundary. Preserve that proof so
    // durable recovery cannot mistake a staging failure for an unknown send.
    throw new PlatformMessageNotDispatchedError(
      `SMS media preparation failed before Twilio dispatch: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  return {
    ...hostedMedia,
    ...(caption ? { caption } : {}),
    remainingChunks,
  };
}

export async function sendPreparedSmsMediaAttempt(params: {
  account: ResolvedSmsAccount;
  to: string;
  attempt: PreparedSmsMediaAttempt;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: SmsDeliveryProgress;
}): Promise<SmsSendResult[]> {
  const results: SmsSendResult[] = [];
  try {
    const mediaResult = await sendSmsProviderMessage({
      account: params.account,
      to: params.to,
      ...(params.attempt.caption ? { text: params.attempt.caption } : {}),
      mediaUrls: [params.attempt.hostedMediaUrl],
      onPlatformSendDispatch: params.onPlatformSendDispatch,
    });
    results.push(mediaResult);
    await params.onDeliveryResult?.(createSmsDeliveryProgressResult(mediaResult, "media"));
    for (const text of params.attempt.remainingChunks) {
      const result = await sendSmsProviderMessage({
        account: params.account,
        to: params.to,
        text,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
      });
      results.push(result);
      await params.onDeliveryResult?.(createSmsDeliveryProgressResult(result, "text"));
    }
  } catch (error) {
    throwSmsPartialDeliveryError(error, results, "media");
  }
  return results;
}
