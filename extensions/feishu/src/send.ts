import * as Lark from "@larksuiteoapi/node-sdk";

import type { MoltbotConfig } from "clawdbot/plugin-sdk";

import { resolveFeishuAccount, type ResolvedFeishuAccount } from "./accounts.js";
import { parseFeishuTarget, type FeishuReceiveIdType } from "./targets.js";

export type SendFeishuMessageParams = {
  account: ResolvedFeishuAccount;
  to: string;
  text: string;
};

export type SendFeishuMessageResult = {
  messageId: string;
};

function requireFeishuCredentials(account: ResolvedFeishuAccount): {
  appId: string;
  appSecret: string;
} {
  const appId = account.appId?.trim();
  const appSecret = account.appSecret?.trim();
  if (!appId || !appSecret) {
    throw new Error(
      `Feishu credentials missing for account "${account.accountId}" (set channels.feishu.appId/appSecret or channels.feishu.accounts.${account.accountId}.appId/appSecret).`,
    );
  }
  return { appId, appSecret };
}

function buildTextContent(text: string): string {
  return JSON.stringify({ text });
}

function readMessageId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return "";
  const record = data as { message_id?: unknown; messageId?: unknown };
  if (typeof record.message_id === "string") return record.message_id;
  if (typeof record.messageId === "string") return record.messageId;
  return "";
}

function resolveTarget(input: string): { receiveIdType: FeishuReceiveIdType; receiveId: string } {
  const parsed = parseFeishuTarget(input);
  if (!parsed) {
    throw new Error(
      "Feishu target is required (use chat:<id>, user:<open_id>, or open_id/user_id/union_id/email prefixes).",
    );
  }
  return parsed;
}

export async function sendFeishuMessage(
  params: SendFeishuMessageParams,
): Promise<SendFeishuMessageResult> {
  const { appId, appSecret } = requireFeishuCredentials(params.account);
  const target = resolveTarget(params.to);
  const client = new Lark.Client({ appId, appSecret });
  const response = await client.im.v1.message.create({
    params: {
      receive_id_type: target.receiveIdType,
    },
    data: {
      receive_id: target.receiveId,
      content: buildTextContent(params.text ?? ""),
      msg_type: "text",
    },
  });
  return { messageId: readMessageId(response) };
}

export async function sendFeishuMessageFromConfig(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  to: string;
  text: string;
}): Promise<SendFeishuMessageResult> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  return await sendFeishuMessage({ account, to: params.to, text: params.text });
}
