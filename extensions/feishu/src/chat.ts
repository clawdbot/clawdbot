import type * as Lark from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuChatSchema, type FeishuChatParams } from "./chat-schema.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
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

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.chat) {
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_chat",
      label: "Feishu Chat",
      description: "Feishu chat operations. Actions: members, info, member_info",
      parameters: FeishuChatSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuChatParams;
        try {
          const client = getClient();
          switch (p.action) {
            case "members":
              if (!p.chat_id) {
                return json({ error: "chat_id is required for action members" });
              }
              return json(
                await getChatMembers(
                  client,
                  p.chat_id,
                  p.page_size,
                  p.page_token,
                  p.member_id_type,
                ),
              );
            case "info":
              if (!p.chat_id) {
                return json({ error: "chat_id is required for action info" });
              }
              return json(await getChatInfo(client, p.chat_id));
            case "member_info":
              if (!p.member_id) {
                return json({ error: "member_id is required for action member_info" });
              }
              return json(
                await getFeishuMemberInfo(client, p.member_id, p.member_id_type ?? "open_id"),
              );
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: formatErrorMessage(err) });
        }
      },
    },
    { name: "feishu_chat" },
  );
}
