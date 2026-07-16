import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

export type FeishuPin = {
  messageId: string;
  chatId?: string;
  operatorId?: string;
  operatorIdType?: string;
  createTime?: string;
};

function assertFeishuPinApiSuccess(response: { code?: number; msg?: string }, action: string) {
  if (response.code !== 0) {
    throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
  }
}

function normalizePin(pin: {
  message_id: string;
  chat_id?: string;
  operator_id?: string;
  operator_id_type?: string;
  create_time?: string;
}): FeishuPin {
  return {
    messageId: pin.message_id,
    chatId: pin.chat_id,
    operatorId: pin.operator_id,
    operatorIdType: pin.operator_id_type,
    createTime: pin.create_time,
  };
}

export async function createPinFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuPin | null> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const response = await client.im.pin.create({
    data: {
      message_id: params.messageId,
    },
  });
  assertFeishuPinApiSuccess(response, "pin create");
  return response.data?.pin ? normalizePin(response.data.pin) : null;
}

export async function removePinFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<void> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const response = await client.im.pin.delete({
    path: {
      message_id: params.messageId,
    },
  });
  assertFeishuPinApiSuccess(response, "pin delete");
}

export async function listPinsFeishu(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  startTime?: string;
  endTime?: string;
  pageSize?: number;
  pageToken?: string;
  accountId?: string;
}): Promise<{ chatId: string; pins: FeishuPin[]; hasMore: boolean; pageToken?: string }> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const response = await client.im.pin.list({
    params: {
      chat_id: params.chatId,
      ...(params.startTime ? { start_time: params.startTime } : {}),
      ...(params.endTime ? { end_time: params.endTime } : {}),
      ...(typeof params.pageSize === "number"
        ? { page_size: Math.max(1, Math.min(100, Math.floor(params.pageSize))) }
        : {}),
      ...(params.pageToken ? { page_token: params.pageToken } : {}),
    },
  });
  assertFeishuPinApiSuccess(response, "pin list");

  return {
    chatId: params.chatId,
    pins: (response.data?.items ?? []).map(normalizePin),
    hasMore: response.data?.has_more === true,
    pageToken: response.data?.page_token,
  };
}
