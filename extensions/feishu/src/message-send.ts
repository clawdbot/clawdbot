import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import { requestFeishuApi } from "./comment-shared.js";

export type FeishuReceiveIdType = "chat_id" | "email" | "open_id" | "union_id" | "user_id";

export type FeishuMessageClient = {
  im: {
    message: Pick<Client["im"]["message"], "create" | "reply">;
  };
};

export async function sendIdempotentFeishuMessage(params: {
  client: FeishuMessageClient;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  content: string;
  msgType: string;
  errorPrefix: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  includeNestedErrorLogId?: boolean;
}) {
  const uuid = randomUUID();
  return requestFeishuApi(
    () => {
      if (params.replyToMessageId) {
        return params.client.im.message.reply({
          path: { message_id: params.replyToMessageId },
          data: {
            content: params.content,
            msg_type: params.msgType,
            uuid,
            ...(params.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
      }

      // Feishu accepts root_id for message.create although the SDK request type omits it.
      const data = {
        receive_id: params.receiveId,
        content: params.content,
        msg_type: params.msgType,
        uuid,
        ...(params.rootId ? { root_id: params.rootId } : {}),
      };
      return params.client.im.message.create({
        params: { receive_id_type: params.receiveIdType },
        data,
      });
    },
    params.errorPrefix,
    {
      includeNestedErrorLogId: params.includeNestedErrorLogId,
      retryTransient: true,
    },
  );
}
