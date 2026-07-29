// Imessage plugin module implements chat behavior.
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
  method: "typing" | "read",
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
