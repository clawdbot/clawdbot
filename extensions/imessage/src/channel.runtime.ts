// Imessage plugin module implements channel behavior.
import {
  createAccountStatusSink,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/channel-outbound";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import {
  listEnabledIMessageAccounts,
  resolveIMessageDuplicateSourceOwner,
  type ResolvedIMessageAccount,
} from "./accounts.js";
import { monitorIMessageProvider } from "./monitor.js";
import { IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";
import { probeIMessage } from "./probe.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";
import { sendMessageIMessage } from "./send.js";
import { imessageSetupWizard } from "./setup-surface.js";

type IMessageSendFn = typeof sendMessageIMessage;

export async function sendIMessageOutbound(params: {
  cfg: Parameters<typeof import("./accounts.js").resolveIMessageAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaAccess?: Parameters<IMessageSendFn>[2]["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: Parameters<IMessageSendFn>[2]["mediaReadFile"];
  audioAsVoice?: boolean;
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string;
  conversationReadOrigin?: "delegated" | "direct-operator";
  onDeliveryResult?: NonNullable<Parameters<IMessageSendFn>[2]["onDeliveryResult"]>;
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
  const result = await send(params.to, params.text, {
    config: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaAccess ? { mediaAccess: params.mediaAccess } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    ...(params.audioAsVoice ? { audioAsVoice: true } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
    conversationReadOrigin: params.conversationReadOrigin,
    ...(params.onDeliveryResult ? { onDeliveryResult: params.onDeliveryResult } : {}),
  });
  const meta = {
    ...(result as typeof result & { meta?: Record<string, unknown> }).meta,
    ...(result.guid ? { imessageMessageGuid: result.guid } : {}),
    ...(result.sentText ? { imessageVisibleText: result.sentText } : {}),
  };
  return Object.keys(meta).length > 0 ? { ...result, meta } : result;
}

export async function notifyIMessageApproval(params: {
  cfg: Parameters<typeof import("./accounts.js").resolveIMessageAccount>[0]["cfg"];
  id: string;
}): Promise<void> {
  await sendMessageIMessage(params.id, PAIRING_APPROVED_MESSAGE, { config: params.cfg });
}

export async function probeIMessageAccount(params?: {
  timeoutMs?: number;
  cliPath?: string;
  dbPath?: string;
  remoteHost?: string;
}) {
  return await probeIMessage(params?.timeoutMs, {
    cliPath: params?.cliPath,
    dbPath: params?.dbPath,
    remoteHost: params?.remoteHost,
    forceRefresh: true,
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
  // Seed the shared process-stable locality cache before comparing account
  // sources so legacy SSH wrappers and explicit remoteHost configs dedupe alike.
  await Promise.all(
    listEnabledIMessageAccounts(ctx.cfg).map(async (candidate) => {
      await resolveIMessageRemoteHost({
        cliPath: candidate.config.cliPath?.trim() || "imsg",
        remoteHost: candidate.config.remoteHost,
      });
    }),
  );
  const ownerAccountId = resolveIMessageDuplicateSourceOwner({ cfg: ctx.cfg, account });
  if (ownerAccountId) {
    // openclaw/openclaw#65141: this account shares a local Messages source with
    // an already-owning account, so spawning a second `imsg rpc` would deliver
    // every inbound twice. Keep the account enabled for outbound sends, status,
    // and capability surfaces; just park the watcher slot until shutdown. Lifecycle stays silent:
    // ready would lie about admission and stopped would invite restart; parked semantics are deferred.
    ctx.log?.info?.(
      `[${account.accountId}] skipping watcher: duplicate iMessage source; using account "${ownerAccountId}"`,
    );
    if (ctx.abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    return;
  }
  const statusSink = createAccountStatusSink({
    accountId: account.accountId,
    setStatus: ctx.setStatus,
  });
  statusSink({ lifecycle: "starting" });
  ctx.log?.info?.(
    `[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
  );
  return await monitorIMessageProvider({
    accountId: account.accountId,
    config: ctx.cfg,
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
    channelRuntime: ctx.channelRuntime,
    statusSink,
  });
}

export { imessageSetupWizard };
