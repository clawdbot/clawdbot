import type { IncomingMessage, ServerResponse } from "node:http";

import type { ClawdbotConfig, MarkdownTableMode } from "clawdbot/plugin-sdk";

import type { ResolvedZaloAccount } from "./accounts.js";
import {
  ZaloApiError,
  deleteWebhook,
  getUpdates,
  sendMessage,
  sendPhoto,
  setWebhook,
  type ZaloFetch,
  type ZaloMessage,
  type ZaloUpdate,
} from "./api.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import { getZaloRuntime } from "./runtime.js";

export type ZaloRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type ZaloMonitorOptions = {
  token: string;
  account: ResolvedZaloAccount;
  config: ClawdbotConfig;
  runtime: ZaloRuntimeEnv;
  abortSignal: AbortSignal;
  useWebhook?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  fetcher?: ZaloFetch;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type ZaloMonitorResult = {
  stop: () => void;
};

const ZALO_TEXT_LIMIT = 2000;
const DEFAULT_MEDIA_MAX_MB = 5;

type ZaloCoreRuntime = ReturnType<typeof getZaloRuntime>;

function logVerbose(core: ZaloCoreRuntime, runtime: ZaloRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[zalo] ${message}`);
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(zalo|zl):/i, "");
    return normalized === normalizedSenderId;
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

type WebhookTarget = {
  token: string;
  account: ResolvedZaloAccount;
  config: ClawdbotConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  secret: string;
  path: string;
  mediaMaxMb: number;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolveWebhookPath(webhookPath?: string, webhookUrl?: string): string | null {
  const trimmedPath = webhookPath?.trim();
  if (trimmedPath) return normalizeWebhookPath(trimmedPath);
  if (webhookUrl?.trim()) {
    try {
      const parsed = new URL(webhookUrl);
      return normalizeWebhookPath(parsed.pathname || "/");
    } catch {
      return null;
    }
  }
  return null;
}

export function registerZaloWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter(
      (entry) => entry !== normalizedTarget,
    );
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

export async function handleZaloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const headerToken = String(req.headers["x-bot-api-secret-token"] ?? "");
  const target = targets.find((entry) => entry.secret === headerToken);
  if (!target) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  // Zalo sends updates directly as { event_name, message, ... }, not wrapped in { ok, result }
  const raw = body.value;
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const update: ZaloUpdate | undefined =
    record && record.ok === true && record.result
      ? (record.result as ZaloUpdate)
      : (record as ZaloUpdate | null) ?? undefined;

  if (!update?.event_name) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });
  processUpdate(
    update,
    target.token,
    target.account,
    target.config,
    target.runtime,
    target.core,
    target.mediaMaxMb,
    target.statusSink,
    target.fetcher,
  ).catch((err) => {
    target.runtime.error?.(`[${target.account.accountId}] Zalo webhook failed: ${String(err)}`);
  });

  res.statusCode = 200;
  res.end("ok");
  return true;
}

function startPollingLoop(params: {
  token: string;
  account: ResolvedZaloAccount;
  config: ClawdbotConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  abortSignal: AbortSignal;
  isStopped: () => boolean;
  mediaMaxMb: number;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
}) {
  const {
    token,
    account,
    config,
    runtime,
    core,
    abortSignal,
    isStopped,
    mediaMaxMb,
    statusSink,
    fetcher,
  } = params;
  const pollTimeout = 30;

  const poll = async () => {
    if (isStopped() || abortSignal.aborted) return;

    try {
      const response = await getUpdates(token, { timeout: pollTimeout }, fetcher);
      if (response.ok && response.result) {
        statusSink?.({ lastInboundAt: Date.now() });
        await processUpdate(
          response.result,
          token,
          account,
          config,
          runtime,
          core,
          mediaMaxMb,
          statusSink,
          fetcher,
        );
      }
    } catch (err) {
      if (err instanceof ZaloApiError && err.isPollingTimeout) {
        // no updates
      } else if (!isStopped() && !abortSignal.aborted) {
        console.error(`[${account.accountId}] Zalo polling error:`, err);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    if (!isStopped() && !abortSignal.aborted) {
      setImmediate(poll);
    }
  };

  void poll();
}

async function processUpdate(
  update: ZaloUpdate,
  token: string,
  account: ResolvedZaloAccount,
  config: ClawdbotConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  mediaMaxMb: number,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
): Promise<void> {
  const { event_name, message } = update;
  if (!message) return;

  switch (event_name) {
    case "message.text.received":
      await handleTextMessage(
        message,
        token,
        account,
        config,
        runtime,
        core,
        statusSink,
        fetcher,
      );
      break;
    case "message.image.received":
      await handleImageMessage(
        message,
        token,
        account,
        config,
        runtime,
        core,
        mediaMaxMb,
        statusSink,
        fetcher,
      );
      break;
    case "message.sticker.received":
      console.log(`[${account.accountId}] Received sticker from ${message.from.id}`);
      break;
    case "message.unsupported.received":
      console.log(
        `[${account.accountId}] Received unsupported message type from ${message.from.id}`,
      );
      break;
  }
}

async function handleTextMessage(
  message: ZaloMessage,
  token: string,
  account: ResolvedZaloAccount,
  config: ClawdbotConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
): Promise<void> {
  const { text } = message;
  if (!text?.trim()) return;

  await processMessageWithPipeline({
    message,
    token,
    account,
    config,
    runtime,
    core,
    text,
    mediaPath: undefined,
    mediaType: undefined,
    statusSink,
    fetcher,
  });
}

async function handleImageMessage(
  message: ZaloMessage,
  token: string,
  account: ResolvedZaloAccount,
  config: ClawdbotConfig,
  runtime: ZaloRuntimeEnv,
  core: ZaloCoreRuntime,
  mediaMaxMb: number,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: ZaloFetch,
): Promise<void> {
  const { photo, caption } = message;

  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  if (photo) {
    try {
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({ url: photo });
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
    } catch (err) {
      console.error(`[${account.accountId}] Failed to download Zalo image:`, err);
    }
  }

  await processMessageWithPipeline({
    message,
    token,
    account,
    config,
    runtime,
    core,
    text: caption,
    mediaPath,
    mediaType,
    statusSink,
    fetcher,
  });
}

async function processMessageWithPipeline(params: {
  message: ZaloMessage;
  token: string;
  account: ResolvedZaloAccount;
  config: ClawdbotConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  text?: string;
  mediaPath?: string;
  mediaType?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
}): Promise<void> {
  const {
    message,
    token,
    account,
    config,
    runtime,
    core,
    text,
    mediaPath,
    mediaType,
    statusSink,
    fetcher,
  } = params;
  const { from, chat, message_id, date } = message;

  const isGroup = chat.chat_type === "GROUP";
  const chatId = chat.id;
  const senderId = from.id;
  const senderName = from.name;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const rawBody = text?.trim() || (mediaPath ? "<media:image>" : "");
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
    rawBody,
    config,
  );
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("zalo").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands }],
      })
    : undefined;

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked zalo DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "zalo",
            id: senderId,
            meta: { name: senderName ?? undefined },
          });

          if (created) {
            logVerbose(core, runtime, `zalo pairing request sender=${senderId}`);
            try {
              await sendMessage(
                token,
                {
                  chat_id: chatId,
                  text: core.channel.pairing.buildPairingReply({
                    channel: "zalo",
                    idLine: `Your Zalo user id: ${senderId}`,
                    code,
                  }),
                },
                fetcher,
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `zalo pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized zalo sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "zalo",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: chatId,
    },
  });

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `zalo: drop control command from unauthorized sender ${senderId}`);
    return;
  }

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Zalo",
    from: fromLabel,
    timestamp: date ? date * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `zalo:group:${chatId}` : `zalo:${senderId}`,
    To: `zalo:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "zalo",
    Surface: "zalo",
    MessageSid: message_id,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "zalo",
    OriginatingTo: `zalo:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`zalo: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "zalo",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverZaloReply({
          payload,
          token,
          chatId,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
          fetcher,
          tableMode,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] Zalo ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

async function deliverZaloReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  token: string;
  chatId: string;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  config: ClawdbotConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, token, chatId, runtime, core, config, accountId, statusSink, fetcher } = params;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : undefined;
      first = false;
      try {
        await sendPhoto(token, { chat_id: chatId, photo: mediaUrl, caption }, fetcher);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Zalo photo send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "zalo", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      ZALO_TEXT_LIMIT,
      chunkMode,
    );
    for (const chunk of chunks) {
      try {
        await sendMessage(token, { chat_id: chatId, text: chunk }, fetcher);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Zalo message send failed: ${String(err)}`);
      }
    }
  }
}

export async function monitorZaloProvider(
  options: ZaloMonitorOptions,
): Promise<ZaloMonitorResult> {
  const {
    token,
    account,
    config,
    runtime,
    abortSignal,
    useWebhook,
    webhookUrl,
    webhookSecret,
    webhookPath,
    statusSink,
    fetcher: fetcherOverride,
  } = options;

  const core = getZaloRuntime();
  const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const fetcher = fetcherOverride ?? resolveZaloProxyFetch(account.config.proxy);

  let stopped = false;
  const stopHandlers: Array<() => void> = [];

  const stop = () => {
    stopped = true;
    for (const handler of stopHandlers) {
      handler();
    }
  };

  if (useWebhook) {
    if (!webhookUrl || !webhookSecret) {
      throw new Error("Zalo webhookUrl and webhookSecret are required for webhook mode");
    }
    if (!webhookUrl.startsWith("https://")) {
      throw new Error("Zalo webhook URL must use HTTPS");
    }
    if (webhookSecret.length < 8 || webhookSecret.length > 256) {
      throw new Error("Zalo webhook secret must be 8-256 characters");
    }

    const path = resolveWebhookPath(webhookPath, webhookUrl);
    if (!path) {
      throw new Error("Zalo webhookPath could not be derived");
    }

    await setWebhook(token, { url: webhookUrl, secret_token: webhookSecret }, fetcher);

    const unregister = registerZaloWebhookTarget({
      token,
      account,
      config,
      runtime,
      core,
      path,
      secret: webhookSecret,
      statusSink: (patch) => statusSink?.(patch),
      mediaMaxMb: effectiveMediaMaxMb,
      fetcher,
    });
    stopHandlers.push(unregister);
    abortSignal.addEventListener(
      "abort",
      () => {
        void deleteWebhook(token, fetcher).catch(() => {});
      },
      { once: true },
    );
    return { stop };
  }

  try {
    await deleteWebhook(token, fetcher);
  } catch {
    // ignore
  }

  startPollingLoop({
    token,
    account,
    config,
    runtime,
    core,
    abortSignal,
    isStopped: () => stopped,
    mediaMaxMb: effectiveMediaMaxMb,
    statusSink,
    fetcher,
  });

  return { stop };
}
