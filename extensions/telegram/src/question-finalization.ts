import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export function registerTelegramQuestionDelivery(params: {
  accountId?: string;
  chatId: string;
  messageId: string | number;
  payload: ReplyPayload;
  text: string;
  textLimit: number;
  clearButtons: () => Promise<void>;
  annotate: (text: string) => Promise<void>;
}): void {
  const questionId = questionGatewayRuntime.readAskUserQuestionId(params.payload);
  const text = params.text.trim();
  if (!questionId || !text) {
    return;
  }
  const { accountId, chatId, messageId, textLimit, clearButtons, annotate } = params;
  const deliveryId = `telegram:${accountId ?? "default"}:${chatId}:${messageId}`;
  questionGatewayRuntime.registerChannelDelivery({
    questionId,
    deliveryId,
    finalize: async (statusLine) => {
      await clearButtons();
      const limit = Math.max(0, Math.floor(textLimit));
      const suffix = truncateUtf16Safe(statusLine.trim(), Math.min(512, limit));
      const separator = suffix && limit - suffix.length >= 2 ? "\n\n" : "";
      const prefix = truncateUtf16Safe(text, limit - separator.length - suffix.length);
      await annotate(`${prefix}${separator}${suffix}`);
    },
  });
}
