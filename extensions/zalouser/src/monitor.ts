import type { ChildProcess } from "node:child_process";

import type { RuntimeEnv } from "../../../src/runtime.js";
import { loadCoreChannelDeps, type CoreChannelDeps } from "./core-bridge.js";
import { sendMessageZalouser } from "./send.js";
import type { CoreConfig, ResolvedZalouserAccount, ZcaMessage } from "./types.js";
import { runZcaStreaming } from "./zca.js";

export type ZalouserMonitorOptions = {
  account: ResolvedZalouserAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type ZalouserMonitorResult = {
  stop: () => void;
};

const ZALOUSER_TEXT_LIMIT = 2000;

function logVerbose(deps: CoreChannelDeps, runtime: RuntimeEnv, message: string): void {
  if (deps.shouldLogVerbose()) {
    runtime.log(`[zalouser] ${message}`);
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(zalouser|zlu):/i, "");
    return normalized === normalizedSenderId;
  });
}

function startZcaListener(
  runtime: RuntimeEnv,
  profile: string,
  onMessage: (msg: ZcaMessage) => void,
  onError: (err: Error) => void,
  abortSignal: AbortSignal,
): ChildProcess {
  let buffer = "";

  const { proc, promise } = runZcaStreaming(["listen", "-r", "-k"], {
    profile,
    onData: (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as ZcaMessage;
          onMessage(parsed);
        } catch {
          // ignore non-JSON lines
        }
      }
    },
    onError,
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) runtime.error(`[zalouser] zca stderr: ${text}`);
  });

  void promise.then((result) => {
    if (!result.ok && !abortSignal.aborted) {
      onError(new Error(result.stderr || `zca listen exited with code ${result.exitCode}`));
    }
  });

  abortSignal.addEventListener(
    "abort",
    () => {
      proc.kill("SIGTERM");
    },
    { once: true },
  );

  return proc;
}

async function processMessage(
  message: ZcaMessage,
  account: ResolvedZalouserAccount,
  config: CoreConfig,
  deps: CoreChannelDeps,
  runtime: RuntimeEnv,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const { threadId, content, timestamp, metadata } = message;
  if (!content?.trim()) return;

  const isGroup = metadata?.isGroup ?? false;
  const senderId = metadata?.fromId ?? threadId;
  const senderName = metadata?.senderName ?? "";
  const chatId = threadId;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(deps, runtime, `Blocked zalouser DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const storeAllowFrom = await deps.readChannelAllowFromStore("zalouser").catch(() => []);
      const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
      const allowed = isSenderAllowed(senderId, effectiveAllowFrom);

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await deps.upsertChannelPairingRequest({
            channel: "zalouser",
            id: senderId,
            meta: { name: senderName || undefined },
          });

          if (created) {
            logVerbose(deps, runtime, `zalouser pairing request sender=${senderId}`);
            try {
              await sendMessageZalouser(
                chatId,
                deps.buildPairingReply({
                  channel: "zalouser",
                  idLine: `Your Zalo user id: ${senderId}`,
                  code,
                }),
                { profile: account.profile },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                deps,
                runtime,
                `zalouser pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            deps,
            runtime,
            `Blocked unauthorized zalouser sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  const peer = isGroup ? { kind: "group" as const, id: chatId } : { kind: "group" as const, id: senderId };

  const route = deps.resolveAgentRoute({
    cfg: config,
    channel: "zalouser",
    accountId: account.accountId,
    peer: {
      // Use "group" kind to avoid dmScope=main collapsing all DMs into the main session.
      kind: peer.kind,
      id: peer.id,
    },
  });

  const rawBody = content.trim();
  const fromLabel = isGroup
    ? `group:${chatId} from ${senderName || senderId}`
    : senderName || `user:${senderId}`;
  const body = deps.formatAgentEnvelope({
    channel: "Zalo Personal",
    from: fromLabel,
    timestamp: timestamp ? timestamp * 1000 : undefined,
    body: rawBody,
  });

  const ctxPayload = {
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `group:${chatId}` : `zalouser:${senderId}`,
    To: `zalouser:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    SenderName: senderName || undefined,
    SenderId: senderId,
    Provider: "zalouser",
    Surface: "zalouser",
    MessageSid: message.msgId ?? `${timestamp}`,
    OriginatingChannel: "zalouser",
    OriginatingTo: `zalouser:${chatId}`,
  };

  await deps.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverZalouserReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          profile: account.profile,
          chatId,
          isGroup,
          runtime,
          deps,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error(
          `[${account.accountId}] Zalouser ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

async function deliverZalouserReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  profile: string;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  deps: CoreChannelDeps;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, profile, chatId, isGroup, runtime, deps, statusSink } = params;

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? payload.text : undefined;
      first = false;
      try {
        logVerbose(deps, runtime, `Sending media to ${chatId}`);
        await sendMessageZalouser(chatId, caption ?? "", {
          profile,
          mediaUrl,
          isGroup,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`Zalouser media send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (payload.text) {
    const chunks = deps.chunkMarkdownText(payload.text, ZALOUSER_TEXT_LIMIT);
    logVerbose(deps, runtime, `Sending ${chunks.length} text chunk(s) to ${chatId}`);
    for (const chunk of chunks) {
      try {
        await sendMessageZalouser(chatId, chunk, { profile, isGroup });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`Zalouser message send failed: ${String(err)}`);
      }
    }
  }
}

export async function monitorZalouserProvider(
  options: ZalouserMonitorOptions,
): Promise<ZalouserMonitorResult> {
  const { account, config, abortSignal, statusSink, runtime } = options;

  const deps = await loadCoreChannelDeps();
  let stopped = false;
  let proc: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveRunning: (() => void) | null = null;

  const stop = () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (proc) {
      proc.kill("SIGTERM");
      proc = null;
    }
    resolveRunning?.();
  };

  const startListener = () => {
    if (stopped || abortSignal.aborted) {
      resolveRunning?.();
      return;
    }

    logVerbose(
      deps,
      runtime,
      `[${account.accountId}] starting zca listener (profile=${account.profile})`,
    );

    proc = startZcaListener(
      runtime,
      account.profile,
      (msg) => {
        logVerbose(deps, runtime, `[${account.accountId}] inbound message`);
        statusSink?.({ lastInboundAt: Date.now() });
        processMessage(msg, account, config, deps, runtime, statusSink).catch((err) => {
          runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
        });
      },
      (err) => {
        runtime.error(`[${account.accountId}] zca listener error: ${String(err)}`);
        if (!stopped && !abortSignal.aborted) {
          logVerbose(deps, runtime, `[${account.accountId}] restarting listener in 5s...`);
          restartTimer = setTimeout(startListener, 5000);
        } else {
          resolveRunning?.();
        }
      },
      abortSignal,
    );
  };

  // Create a promise that stays pending until abort or stop
  const runningPromise = new Promise<void>((resolve) => {
    resolveRunning = resolve;
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

  startListener();

  // Wait for the running promise to resolve (on abort/stop)
  await runningPromise;

  return { stop };
}
