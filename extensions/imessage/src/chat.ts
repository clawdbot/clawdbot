import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { formatIMessageChatTarget, type IMessageService, parseIMessageTarget } from "./targets.js";

type ChatActionOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  account?: ResolvedIMessageAccount;
  client?: IMessageRpcClient;
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  timeoutMs?: number;
  chatId?: number;
};

function buildChatTargetParams(
  to: string,
  opts: ChatActionOpts,
): {
  params: Record<string, unknown>;
  service?: IMessageService;
  region?: string;
  account: ResolvedIMessageAccount;
} {
  const cfg = requireRuntimeConfig(opts.cfg, "iMessage chat action");
  const account = opts.account ?? resolveIMessageAccount({ cfg, accountId: opts.accountId });
  const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
  const params: Record<string, unknown> = {};
  if (target.kind === "chat_id") {
    params.chat_id = target.chatId;
  } else if (target.kind === "chat_guid") {
    params.chat_guid = target.chatGuid;
  } else if (target.kind === "chat_identifier") {
    params.chat_identifier = target.chatIdentifier;
  } else {
    params.to = target.to;
  }
  const service =
    opts.service ??
    (target.kind === "handle" ? target.service : undefined) ??
    (account.config.service as IMessageService | undefined);
  const region = opts.region?.trim() || account.config.region?.trim() || "US";
  return { params, service, region, account };
}

async function runChatAction<T>(
  method:
    | "typing"
    | "read"
    | "chats.create"
    | "chats.delete"
    | "chats.markUnread"
    | "group.rename"
    | "group.setIcon"
    | "group.addParticipant"
    | "group.removeParticipant"
    | "group.leave",
  params: Record<string, unknown>,
  opts: ChatActionOpts,
): Promise<T> {
  const cfg = requireRuntimeConfig(opts.cfg, "iMessage chat action");
  const account = opts.account ?? resolveIMessageAccount({ cfg, accountId: opts.accountId });
  const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
  const client = opts.client ?? (await createIMessageRpcClient({ cliPath, dbPath }));
  const shouldClose = !opts.client;
  try {
    return await client.request<T>(method, params, { timeoutMs: opts.timeoutMs });
  } finally {
    if (shouldClose) {
      await client.stop();
    }
  }
}

export async function sendIMessageTyping(
  to: string,
  isTyping: boolean,
  opts: ChatActionOpts,
): Promise<void> {
  const { params, service } = buildChatTargetParams(to, opts);
  params.typing = isTyping;
  if (service) {
    params.service = service;
  }
  await runChatAction<{ ok?: boolean }>("typing", params, opts);
}

export async function markIMessageChatRead(to: string, opts: ChatActionOpts): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  await runChatAction<{ ok?: boolean }>("read", params, opts);
}

export async function markIMessageChatUnread(to: string, opts: ChatActionOpts): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  await runChatAction<{ ok?: boolean }>("chats.markUnread", params, opts);
}

export async function createIMessageChat(
  params: {
    addresses: string[];
    name?: string;
    text?: string;
    service?: "iMessage" | "SMS";
  },
  opts: Omit<ChatActionOpts, "chatId">,
): Promise<{ chatGuid?: string }> {
  if (!params.addresses.length) {
    throw new Error("createIMessageChat requires at least one address");
  }
  const rpcParams: Record<string, unknown> = {
    addresses: params.addresses,
    service: params.service ?? "iMessage",
  };
  if (params.name) {
    rpcParams.name = params.name;
  }
  if (params.text) {
    rpcParams.text = params.text;
  }
  const result = await runChatAction<{ ok?: boolean; chat_guid?: string }>(
    "chats.create",
    rpcParams,
    opts,
  );
  return { chatGuid: result.chat_guid };
}

export async function deleteIMessageChat(to: string, opts: ChatActionOpts): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  await runChatAction<{ ok?: boolean }>("chats.delete", params, opts);
}

export async function renameIMessageGroup(
  to: string,
  name: string,
  opts: ChatActionOpts,
): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  params.name = name;
  await runChatAction<{ ok?: boolean }>("group.rename", params, opts);
}

export async function setIMessageGroupIcon(
  to: string,
  filePath: string | undefined,
  opts: ChatActionOpts,
): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  if (filePath) {
    params.file = filePath;
  }
  await runChatAction<{ ok?: boolean }>("group.setIcon", params, opts);
}

export async function addIMessageGroupParticipant(
  to: string,
  address: string,
  opts: ChatActionOpts,
): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  params.address = address;
  await runChatAction<{ ok?: boolean }>("group.addParticipant", params, opts);
}

export async function removeIMessageGroupParticipant(
  to: string,
  address: string,
  opts: ChatActionOpts,
): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  params.address = address;
  await runChatAction<{ ok?: boolean }>("group.removeParticipant", params, opts);
}

export async function leaveIMessageGroup(to: string, opts: ChatActionOpts): Promise<void> {
  const { params } = buildChatTargetParams(to, opts);
  await runChatAction<{ ok?: boolean }>("group.leave", params, opts);
}
