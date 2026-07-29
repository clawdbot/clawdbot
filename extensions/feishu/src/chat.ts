// Feishu plugin module implements chat behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuChatSchema, type FeishuChatParams } from "./chat-schema.js";
import { resolveFeishuChatType } from "./chat-type.js";
import { createFeishuClient } from "./client.js";
import { formatFeishuApiError } from "./comment-shared.js";
import {
  assertFeishuChatReadAllowed,
  authorizeFeishuChatMemberRead,
  resolveFeishuChatReadPreliminaryAuthorization,
  type FeishuChatMemberReadAuthorization,
} from "./read-policy.js";
import { resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount } from "./tool-account.js";

function readChatPageSize(params: Record<string, unknown>): number | undefined {
  return readPositiveIntegerParam(params, "page_size", {
    max: 100,
    message: "page_size must be a positive integer between 1 and 100",
  });
}

export function buildFeishuDirectChatMembers(
  authorization: Extract<FeishuChatMemberReadAuthorization, { kind: "direct" }>,
) {
  return {
    chat_id: authorization.chatId,
    has_more: false,
    page_token: undefined,
    members: [
      {
        member_id: authorization.memberId,
        name: undefined,
        tenant_key: undefined,
        member_id_type: authorization.memberIdType,
      },
    ],
  };
}

export async function getChatInfo(client: Lark.Client, chatId: string) {
  const res = await client.im.chat.get({ path: { chat_id: chatId } });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const chat = res.data;
  return {
    chat_id: chatId,
    name: chat?.name,
    description: chat?.description,
    owner_id: chat?.owner_id,
    tenant_key: chat?.tenant_key,
    user_count: chat?.user_count,
    chat_mode: chat?.chat_mode,
    chat_type: chat?.chat_type,
    join_message_visibility: chat?.join_message_visibility,
    leave_message_visibility: chat?.leave_message_visibility,
    membership_approval: chat?.membership_approval,
    moderation_permission: chat?.moderation_permission,
    avatar: chat?.avatar,
  };
}

function authorizeFeishuChatInfo(params: {
  cfg: NonNullable<OpenClawPluginApi["config"]>;
  account: ReturnType<typeof resolveFeishuToolAccount>;
  chatId: string;
  chat: Awaited<ReturnType<typeof getChatInfo>>;
  ctx: OpenClawPluginToolContext;
}): void {
  assertFeishuChatReadAllowed({
    cfg: params.cfg,
    account: params.account,
    chatId: params.chatId,
    chatType: resolveFeishuChatType(params.chat),
    ctx: params.ctx,
  });
}

async function getAuthorizedFeishuChatInfo(params: {
  client: Lark.Client;
  cfg: NonNullable<OpenClawPluginApi["config"]>;
  account: ReturnType<typeof resolveFeishuToolAccount>;
  chatId: string;
  ctx: OpenClawPluginToolContext;
}) {
  const preliminary = resolveFeishuChatReadPreliminaryAuthorization({
    cfg: params.cfg,
    account: params.account,
    chatId: params.chatId,
    ctx: params.ctx,
  });
  if (preliminary.decision === "deny") {
    assertFeishuChatReadAllowed({
      cfg: params.cfg,
      account: params.account,
      chatId: preliminary.chatId,
      ctx: params.ctx,
    });
  }
  let chat: Awaited<ReturnType<typeof getChatInfo>>;
  try {
    // Only targets with at least one authorized conversation kind reach metadata.
    // Hide lookup failures when type is needed so metadata cannot become an existence oracle.
    chat = await getChatInfo(params.client, preliminary.chatId);
  } catch (error) {
    if (preliminary.decision === "needs-metadata") {
      assertFeishuChatReadAllowed({
        cfg: params.cfg,
        account: params.account,
        chatId: preliminary.chatId,
        ctx: params.ctx,
      });
    }
    throw error;
  }
  authorizeFeishuChatInfo({
    cfg: params.cfg,
    account: params.account,
    chatId: preliminary.chatId,
    chat,
    ctx: params.ctx,
  });
  return chat;
}

export async function getChatMembers(
  client: Lark.Client,
  chatId: string,
  pageSize?: number,
  pageToken?: string,
  memberIdType?: "open_id" | "user_id" | "union_id",
) {
  const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
  const res = await client.im.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      page_size,
      page_token: pageToken,
      member_id_type: memberIdType ?? "open_id",
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    chat_id: chatId,
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    members:
      res.data?.items?.map((item) => ({
        member_id: item.member_id,
        name: item.name,
        tenant_key: item.tenant_key,
        member_id_type: item.member_id_type,
      })) ?? [],
  };
}

export async function assertFeishuChatMember(
  client: Lark.Client,
  chatId: string,
  memberId: string,
  memberIdType: "open_id" | "user_id" | "union_id" = "open_id",
): Promise<void> {
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  while (true) {
    const members = await getChatMembers(client, chatId, 100, pageToken, memberIdType);
    if (members.members.some((member) => member.member_id === memberId)) {
      return;
    }
    if (!members.has_more || !members.page_token) {
      break;
    }
    if (seenPageTokens.has(members.page_token)) {
      throw new Error(`Feishu chat member pagination repeated token for chat ${chatId}`);
    }
    seenPageTokens.add(members.page_token);
    pageToken = members.page_token;
  }
  throw new Error(`Member ${memberId} is not a member of chat ${chatId}`);
}

export async function getFeishuMemberInfo(
  client: Lark.Client,
  memberId: string,
  memberIdType: "open_id" | "user_id" | "union_id" = "open_id",
) {
  const res = await client.contact.user.get({
    path: { user_id: memberId },
    params: {
      user_id_type: memberIdType,
      department_id_type: "open_department_id",
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const user = res.data?.user;
  return {
    member_id: memberId,
    member_id_type: memberIdType,
    open_id: user?.open_id,
    user_id: user?.user_id,
    union_id: user?.union_id,
    name: user?.name,
    en_name: user?.en_name,
    nickname: user?.nickname,
    email: user?.email,
    enterprise_email: user?.enterprise_email,
    mobile: user?.mobile,
    mobile_visible: user?.mobile_visible,
    status: user?.status,
    avatar: user?.avatar,
    department_ids: user?.department_ids,
    department_path: user?.department_path,
    leader_user_id: user?.leader_user_id,
    city: user?.city,
    country: user?.country,
    work_station: user?.work_station,
    join_time: user?.join_time,
    is_tenant_manager: user?.is_tenant_manager,
    employee_no: user?.employee_no,
    employee_type: user?.employee_type,
    description: user?.description,
    job_title: user?.job_title,
    geo: user?.geo,
  };
}

export function registerFeishuChatTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }
  const cfg = api.config;

  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.chat) {
    return;
  }

  api.registerTool(
    (toolContext: OpenClawPluginToolContext) => ({
      name: "feishu_chat",
      label: "Feishu Chat",
      description: "Feishu chat operations. Actions: members, info, member_info",
      parameters: FeishuChatSchema,
      async execute(_toolCallId, params) {
        const rawParams = params as Record<string, unknown>;
        const p = params as FeishuChatParams;
        try {
          const account = resolveFeishuToolAccount({
            api,
            defaultAccountId: toolContext.agentAccountId,
            requiredTool: { family: "chat", label: "chat" },
          });
          const client = createFeishuClient(account);
          switch (p.action) {
            case "members":
              if (!p.chat_id) {
                return json({ error: "chat_id is required for action members" });
              }
              {
                const chat = await getAuthorizedFeishuChatInfo({
                  client,
                  cfg,
                  account,
                  chatId: p.chat_id,
                  ctx: toolContext,
                });
                const authorization = authorizeFeishuChatMemberRead({
                  cfg,
                  account,
                  chatId: p.chat_id,
                  chatType: resolveFeishuChatType(chat),
                  ctx: toolContext,
                  memberIdType: p.member_id_type,
                });
                if (authorization.kind === "direct") {
                  return json(buildFeishuDirectChatMembers(authorization));
                }
              }
              return json(
                await getChatMembers(
                  client,
                  p.chat_id,
                  readChatPageSize(rawParams),
                  p.page_token,
                  p.member_id_type,
                ),
              );
            case "info":
              if (!p.chat_id) {
                return json({ error: "chat_id is required for action info" });
              }
              {
                const chat = await getAuthorizedFeishuChatInfo({
                  client,
                  cfg,
                  account,
                  chatId: p.chat_id,
                  ctx: toolContext,
                });
                return json(chat);
              }
            case "member_info":
              if (!p.member_id) {
                return json({ error: "member_id is required for action member_info" });
              }
              if (!p.chat_id) {
                return json({ error: "chat_id is required for action member_info" });
              }
              {
                const chat = await getAuthorizedFeishuChatInfo({
                  client,
                  cfg,
                  account,
                  chatId: p.chat_id,
                  ctx: toolContext,
                });
                const authorization = authorizeFeishuChatMemberRead({
                  cfg,
                  account,
                  chatId: p.chat_id,
                  chatType: resolveFeishuChatType(chat),
                  ctx: toolContext,
                  memberId: p.member_id,
                  memberIdType: p.member_id_type,
                });
                if (authorization.kind === "group") {
                  const memberIdType = p.member_id_type ?? "open_id";
                  await assertFeishuChatMember(client, p.chat_id, p.member_id, memberIdType);
                  return json(await getFeishuMemberInfo(client, p.member_id, memberIdType));
                }
                return json(
                  await getFeishuMemberInfo(
                    client,
                    authorization.memberId,
                    authorization.memberIdType,
                  ),
                );
              }
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: formatFeishuApiError(err, { includeNestedErrorLogId: true }) });
        }
      },
    }),
    {
      name: "feishu_chat",
    },
  );
}
