import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { PAIRING_APPROVED_MESSAGE, resolveChannelMediaMaxBytes } from "./channel-api.js";
import type { ChannelPlugin } from "./channel-api.js";
import { monitorIMessageProvider } from "./monitor.js";
import { IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";
import { probeIMessage } from "./probe.js";
import { sendMessageIMessage } from "./send.js";
import { imessageSetupWizard } from "./setup-surface.js";

type IMessageSendFn = typeof sendMessageIMessage;

export async function sendIMessageOutbound(params: {
  cfg: Parameters<typeof import("./accounts.js").resolveIMessageAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string;
}) {
  const send =
    resolveOutboundSendDep<IMessageSendFn>(params.deps, "imessage", {
      legacyKeys: IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS,
    }) ?? sendMessageIMessage;
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
      cfg.channels?.imessage?.mediaMaxMb,
    accountId: params.accountId,
  });
  return await send(params.to, params.text, {
    config: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
  });
}

export async function notifyIMessageApproval(id: string): Promise<void> {
  await sendMessageIMessage(id, PAIRING_APPROVED_MESSAGE);
}

export async function probeIMessageAccount(params?: {
  timeoutMs?: number;
  cliPath?: string;
  dbPath?: string;
}) {
  return await probeIMessage(params?.timeoutMs, {
    cliPath: params?.cliPath,
    dbPath: params?.dbPath,
  });
}

export async function startIMessageGatewayAccount(
  ctx: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedIMessageAccount>["gateway"]>["startAccount"]>
  >[0],
) {
  const account = ctx.account;
  const cliPath = account.config.cliPath?.trim() || "imsg";
  const dbPath = account.config.dbPath?.trim();
  ctx.setStatus({
    accountId: account.accountId,
    cliPath,
    dbPath: dbPath ?? null,
  });
  ctx.log?.info?.(
    `[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
  );
  return await monitorIMessageProvider({
    accountId: account.accountId,
    config: ctx.cfg,
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
  });
}

export { imessageSetupWizard };
