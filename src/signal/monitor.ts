import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { mediaKindFromMime } from "../media/constants.js";
import { saveMediaBuffer } from "../media/store.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeE164 } from "../utils.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalCheck, signalRpcRequest } from "./client.js";
import { spawnSignalDaemon } from "./daemon.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "./identity.js";
import { sendMessageSignal } from "./send.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

type SignalEnvelope = {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number | null;
  dataMessage?: SignalDataMessage | null;
  editMessage?: { dataMessage?: SignalDataMessage | null } | null;
  syncMessage?: unknown;
};

type SignalDataMessage = {
  timestamp?: number;
  message?: string | null;
  attachments?: Array<SignalAttachment>;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
  quote?: { text?: string | null } | null;
};

type SignalAttachment = {
  id?: string | null;
  contentType?: string | null;
  filename?: string | null;
  size?: number | null;
};

export type MonitorSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  account?: string;
  accountId?: string;
  config?: ClawdbotConfig;
  baseUrl?: string;
  autoStart?: boolean;
  cliPath?: string;
  httpHost?: string;
  httpPort?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
};

type SignalReceivePayload = {
  account?: string;
  envelope?: SignalEnvelope | null;
  exception?: { message?: string } | null;
};

function resolveRuntime(opts: MonitorSignalOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function normalizeAllowList(raw?: Array<string | number>): string[] {
  return (raw ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

async function waitForSignalDaemonReady(params: {
  baseUrl: string;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  runtime: RuntimeEnv;
}): Promise<void> {
  const started = Date.now();
  let lastError: string | null = null;

  while (Date.now() - started < params.timeoutMs) {
    if (params.abortSignal?.aborted) return;
    const res = await signalCheck(params.baseUrl, 1000);
    if (res.ok) return;
    lastError =
      res.error ?? (res.status ? `HTTP ${res.status}` : "unreachable");
    await new Promise((r) => setTimeout(r, 150));
  }

  params.runtime.error?.(
    danger(
      `daemon not ready after ${params.timeoutMs}ms (${lastError ?? "unknown error"})`,
    ),
  );
  throw new Error(`signal daemon not ready (${lastError ?? "unknown error"})`);
}

async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  attachment: SignalAttachment;
  sender?: string;
  groupId?: string;
  maxBytes: number;
}): Promise<{ path: string; contentType?: string } | null> {
  const { attachment } = params;
  if (!attachment?.id) return null;
  if (attachment.size && attachment.size > params.maxBytes) {
    throw new Error(
      `Signal attachment ${attachment.id} exceeds ${(params.maxBytes / (1024 * 1024)).toFixed(0)}MB limit`,
    );
  }
  const rpcParams: Record<string, unknown> = {
    id: attachment.id,
  };
  if (params.account) rpcParams.account = params.account;
  if (params.groupId) rpcParams.groupId = params.groupId;
  else if (params.sender) rpcParams.recipient = params.sender;
  else return null;

  const result = await signalRpcRequest<{ data?: string }>(
    "getAttachment",
    rpcParams,
    { baseUrl: params.baseUrl },
  );
  if (!result?.data) return null;
  const buffer = Buffer.from(result.data, "base64");
  const saved = await saveMediaBuffer(
    buffer,
    attachment.contentType ?? undefined,
    "inbound",
    params.maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  baseUrl: string;
  account?: string;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
}) {
  const {
    replies,
    target,
    baseUrl,
    account,
    accountId,
    runtime,
    maxBytes,
    textLimit,
  } = params;
  for (const payload of replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text, textLimit)) {
        await sendMessageSignal(target, chunk, {
          baseUrl,
          account,
          maxBytes,
          accountId,
        });
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSignal(target, caption, {
          baseUrl,
          account,
          mediaUrl: url,
          maxBytes,
          accountId,
        });
      }
    }
    runtime.log?.(`delivered reply to ${target}`);
  }
}

export async function monitorSignalProvider(
  opts: MonitorSignalOpts = {},
): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? loadConfig();
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const textLimit = resolveTextChunkLimit(cfg, "signal", accountInfo.accountId);
  const baseUrl = opts.baseUrl?.trim() || accountInfo.baseUrl;
  const account = opts.account?.trim() || accountInfo.config.account?.trim();
  const dmPolicy = accountInfo.config.dmPolicy ?? "pairing";
  const allowFrom = normalizeAllowList(
    opts.allowFrom ?? accountInfo.config.allowFrom,
  );
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      accountInfo.config.groupAllowFrom ??
      (accountInfo.config.allowFrom && accountInfo.config.allowFrom.length > 0
        ? accountInfo.config.allowFrom
        : []),
  );
  const groupPolicy = accountInfo.config.groupPolicy ?? "open";
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? accountInfo.config.mediaMaxMb ?? 8) * 1024 * 1024;
  const ignoreAttachments =
    opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments ?? false;

  const autoStart =
    opts.autoStart ??
    accountInfo.config.autoStart ??
    !accountInfo.config.httpUrl;
  let daemonHandle: ReturnType<typeof spawnSignalDaemon> | null = null;

  if (autoStart) {
    const cliPath = opts.cliPath ?? accountInfo.config.cliPath ?? "signal-cli";
    const httpHost =
      opts.httpHost ?? accountInfo.config.httpHost ?? "127.0.0.1";
    const httpPort = opts.httpPort ?? accountInfo.config.httpPort ?? 8080;
    daemonHandle = spawnSignalDaemon({
      cliPath,
      account,
      httpHost,
      httpPort,
      receiveMode: opts.receiveMode ?? accountInfo.config.receiveMode,
      ignoreAttachments:
        opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments,
      ignoreStories: opts.ignoreStories ?? accountInfo.config.ignoreStories,
      sendReadReceipts:
        opts.sendReadReceipts ?? accountInfo.config.sendReadReceipts,
      runtime,
    });
  }

  const onAbort = () => {
    daemonHandle?.stop();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (daemonHandle) {
      await waitForSignalDaemonReady({
        baseUrl,
        abortSignal: opts.abortSignal,
        timeoutMs: 10_000,
        runtime,
      });
    }

    const handleEvent = async (event: { event?: string; data?: string }) => {
      if (event.event !== "receive" || !event.data) return;
      let payload: SignalReceivePayload | null = null;
      try {
        payload = JSON.parse(event.data) as SignalReceivePayload;
      } catch (err) {
        runtime.error?.(`failed to parse event: ${String(err)}`);
        return;
      }
      if (payload?.exception?.message) {
        runtime.error?.(`receive exception: ${payload.exception.message}`);
      }
      const envelope = payload?.envelope;
      if (!envelope) return;
      if (envelope.syncMessage) return;
      const dataMessage =
        envelope.dataMessage ?? envelope.editMessage?.dataMessage;
      if (!dataMessage) return;

      const sender = resolveSignalSender(envelope);
      if (!sender) return;
      if (account && sender.kind === "phone") {
        if (sender.e164 === normalizeE164(account)) {
          return;
        }
      }
      const senderDisplay = formatSignalSenderDisplay(sender);
      const senderRecipient = resolveSignalRecipient(sender);
      const senderPeerId = resolveSignalPeerId(sender);
      const senderAllowId = formatSignalSenderId(sender);
      if (!senderRecipient) return;
      const senderIdLine = formatSignalPairingIdLine(sender);
      const groupId = dataMessage.groupInfo?.groupId ?? undefined;
      const groupName = dataMessage.groupInfo?.groupName ?? undefined;
      const isGroup = Boolean(groupId);
      const storeAllowFrom = await readProviderAllowFromStore("signal").catch(
        () => [],
      );
      const effectiveDmAllow = [...allowFrom, ...storeAllowFrom];
      const effectiveGroupAllow = [...groupAllowFrom, ...storeAllowFrom];
      const dmAllowed =
        dmPolicy === "open"
          ? true
          : isSignalSenderAllowed(sender, effectiveDmAllow);

      if (!isGroup) {
        if (dmPolicy === "disabled") return;
        if (!dmAllowed) {
          if (dmPolicy === "pairing") {
            const senderId = senderAllowId;
            const { code, created } = await upsertProviderPairingRequest({
              provider: "signal",
              id: senderId,
              meta: {
                name: envelope.sourceName ?? undefined,
              },
            });
            if (created) {
              logVerbose(`signal pairing request sender=${senderId}`);
              try {
                await sendMessageSignal(
                  `signal:${senderRecipient}`,
                  buildPairingReply({
                    provider: "signal",
                    idLine: senderIdLine,
                    code,
                  }),
                  {
                    baseUrl,
                    account,
                    maxBytes: mediaMaxBytes,
                    accountId: accountInfo.accountId,
                  },
                );
              } catch (err) {
                logVerbose(
                  `signal pairing reply failed for ${senderId}: ${String(err)}`,
                );
              }
            }
          } else {
            logVerbose(
              `Blocked signal sender ${senderDisplay} (dmPolicy=${dmPolicy})`,
            );
          }
          return;
        }
      }
      if (isGroup && groupPolicy === "disabled") {
        logVerbose("Blocked signal group message (groupPolicy: disabled)");
        return;
      }
      if (isGroup && groupPolicy === "allowlist") {
        if (effectiveGroupAllow.length === 0) {
          logVerbose(
            "Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)",
          );
          return;
        }
        if (!isSignalSenderAllowed(sender, effectiveGroupAllow)) {
          logVerbose(
            `Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`,
          );
          return;
        }
      }

      const commandAuthorized = isGroup
        ? effectiveGroupAllow.length > 0
          ? isSignalSenderAllowed(sender, effectiveGroupAllow)
          : true
        : dmAllowed;
      const messageText = (dataMessage.message ?? "").trim();

      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      let placeholder = "";
      const firstAttachment = dataMessage.attachments?.[0];
      if (firstAttachment?.id && !ignoreAttachments) {
        try {
          const fetched = await fetchAttachment({
            baseUrl,
            account,
            attachment: firstAttachment,
            sender: senderRecipient,
            groupId,
            maxBytes: mediaMaxBytes,
          });
          if (fetched) {
            mediaPath = fetched.path;
            mediaType =
              fetched.contentType ?? firstAttachment.contentType ?? undefined;
          }
        } catch (err) {
          runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
        }
      }

      const kind = mediaKindFromMime(mediaType ?? undefined);
      if (kind) {
        placeholder = `<media:${kind}>`;
      } else if (dataMessage.attachments?.length) {
        placeholder = "<media:attachment>";
      }

      const bodyText =
        messageText || placeholder || dataMessage.quote?.text?.trim() || "";
      if (!bodyText) return;

      const fromLabel = isGroup
        ? `${groupName ?? "Signal Group"} id:${groupId}`
        : `${envelope.sourceName ?? senderDisplay} id:${senderDisplay}`;
      const body = formatAgentEnvelope({
        provider: "Signal",
        from: fromLabel,
        timestamp: envelope.timestamp ?? undefined,
        body: bodyText,
      });

      const route = resolveAgentRoute({
        cfg,
        provider: "signal",
        accountId: accountInfo.accountId,
        peer: {
          kind: isGroup ? "group" : "dm",
          id: isGroup ? (groupId ?? "unknown") : senderPeerId,
        },
      });
      const signalTo = isGroup
        ? `group:${groupId}`
        : `signal:${senderRecipient}`;
      const ctxPayload = {
        Body: body,
        From: isGroup
          ? `group:${groupId ?? "unknown"}`
          : `signal:${senderRecipient}`,
        To: signalTo,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? (groupName ?? undefined) : undefined,
        SenderName: envelope.sourceName ?? senderDisplay,
        SenderId: senderDisplay,
        Provider: "signal" as const,
        Surface: "signal" as const,
        MessageSid: envelope.timestamp ? String(envelope.timestamp) : undefined,
        Timestamp: envelope.timestamp ?? undefined,
        MediaPath: mediaPath,
        MediaType: mediaType,
        MediaUrl: mediaPath,
        CommandAuthorized: commandAuthorized,
        // Originating channel for reply routing.
        OriginatingChannel: "signal" as const,
        OriginatingTo: signalTo,
      };

      if (!isGroup) {
        const sessionCfg = cfg.session;
        const storePath = resolveStorePath(sessionCfg?.store, {
          agentId: route.agentId,
        });
        await updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          provider: "signal",
          to: senderRecipient,
          accountId: route.accountId,
        });
      }

      if (shouldLogVerbose()) {
        const preview = body.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
        );
      }

      const dispatcher = createReplyDispatcher({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
          .responsePrefix,
        deliver: async (payload) => {
          await deliverReplies({
            replies: [payload],
            target: ctxPayload.To,
            baseUrl,
            account,
            accountId: accountInfo.accountId,
            runtime,
            maxBytes: mediaMaxBytes,
            textLimit,
          });
        },
        onError: (err, info) => {
          runtime.error?.(
            danger(`signal ${info.kind} reply failed: ${String(err)}`),
          );
        },
      });

      const { queuedFinal } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
      });
      if (!queuedFinal) return;
    };

    await runSignalSseLoop({
      baseUrl,
      account,
      abortSignal: opts.abortSignal,
      runtime,
      onEvent: (event) => {
        void handleEvent(event).catch((err) => {
          runtime.error?.(`event handler failed: ${String(err)}`);
        });
      },
    });
  } catch (err) {
    if (opts.abortSignal?.aborted) return;
    throw err;
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
    daemonHandle?.stop();
  }
}
