// Registers Feishu question cards for terminal edits after Gateway resolution.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { buildFinalizedFeishuQuestionCard } from "./presentation-card.js";
import type { ClawdbotConfig } from "./reply-dispatcher-runtime-api.js";
import { editMessageFeishu } from "./send.js";

export function registerFeishuQuestionDelivery(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  questionId: string;
  messageId: string;
  deliveryScope: string;
  card: Record<string, unknown>;
}): void {
  questionGatewayRuntime.registerChannelDelivery({
    questionId: params.questionId,
    deliveryId: `feishu:${params.accountId ?? "default"}:${params.deliveryScope}:${params.messageId}`,
    finalize: async (statusLine) => {
      await editMessageFeishu({
        cfg: params.cfg,
        accountId: params.accountId,
        messageId: params.messageId,
        card: buildFinalizedFeishuQuestionCard({
          card: params.card,
          statusLine,
        }),
      });
    },
  });
}
