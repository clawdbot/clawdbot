// Whatsapp plugin module implements channel outbound behavior.
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { normalizeWhatsAppPayloadTextPreservingIndentation } from "./outbound-media-contract.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "./send.js";

const loadWhatsAppApprovalReactionsModule = createLazyRuntimeModule(
  () => import("./approval-reactions.js"),
);
const loadWhatsAppQuestionReactionsModule = createLazyRuntimeModule(
  () => import("./question-reactions.js"),
);

function normalizeWhatsAppChannelPayloadText(text: string | undefined): string {
  return normalizeWhatsAppPayloadTextPreservingIndentation(text);
}

function normalizeWhatsAppChannelSendText(text: string | undefined): string {
  const normalized = normalizeWhatsAppChannelPayloadText(text);
  return normalized.trim() ? normalized : "";
}

async function prepareWhatsAppApprovalPayloadForDelivery(
  params: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0],
) {
  const questionPayload = questionGatewayRuntime.prepareReactionPayloadForDelivery({
    payload: params.payload,
    presentation: params.presentation,
  });
  if (questionPayload) {
    return questionPayload;
  }
  return (await loadWhatsAppApprovalReactionsModule()).prepareWhatsAppApprovalPayloadForDelivery({
    payload: params.payload,
    presentation: params.presentation,
  });
}

async function registerDeliveredWhatsAppApprovalPayload(
  params: Parameters<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>[0],
): Promise<void> {
  (
    await loadWhatsAppQuestionReactionsModule()
  ).registerWhatsAppQuestionReactionTargetForDeliveredPayload(params);
  (
    await loadWhatsAppApprovalReactionsModule()
  ).registerWhatsAppApprovalReactionTargetForDeliveredPayload(params);
}

export const whatsappChannelOutbound = {
  ...createWhatsAppOutboundBase({
    chunker: chunkText,
    sendMessageWhatsApp: async (to, text, options) =>
      await sendMessageWhatsApp(to, text, {
        ...options,
        preserveLeadingWhitespace: true,
      }),
    sendPollWhatsApp,
    shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
    resolveTarget: ({ to, allowFrom, mode }) =>
      resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
    normalizeText: normalizeWhatsAppChannelSendText,
  }),
  sendTextOnlyErrorPayloads: true,
  renderPresentation: prepareWhatsAppApprovalPayloadForDelivery,
  afterDeliverPayload: registerDeliveredWhatsAppApprovalPayload,
  normalizePayload: ({ payload }: { payload: { text?: string } }) => ({
    ...payload,
    text: normalizeWhatsAppChannelPayloadText(payload.text),
  }),
};

function toWhatsAppMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof whatsappChannelOutbound.sendText>>>,
  replyToId?: string | null,
): ChannelMessageSendResult {
  const source = result as typeof result & { toJid?: string };
  const receipt =
    result.receipt ??
    createMessageReceiptFromOutboundResults({
      results: result.messageId
        ? [
            {
              channel: "whatsapp",
              messageId: result.messageId,
              toJid: source.toJid,
            },
          ]
        : [],
      kind: "text",
      ...(replyToId ? { replyToId } : {}),
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const whatsappMessageAdapter = defineChannelMessageAdapter({
  id: "whatsapp",
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ onDeliveryResult, ...ctx }) => {
      const result = await whatsappChannelOutbound.sendText!({
        ...ctx,
        onDeliveryResult: onDeliveryResult
          ? async (progress) => {
              await onDeliveryResult(toWhatsAppMessageSendResult(progress, ctx.replyToId));
            }
          : undefined,
      });
      return toWhatsAppMessageSendResult(result, ctx.replyToId);
    },
  },
});
