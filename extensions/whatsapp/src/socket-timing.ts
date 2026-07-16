// Whatsapp plugin module implements socket timing behavior.
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WAPresence,
} from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";

export type WhatsAppSocketTimingOptions = {
  keepAliveIntervalMs?: number;
  connectTimeoutMs?: number;
  defaultQueryTimeoutMs?: number;
};

export type WhatsAppSocketOperationAdapter = {
  sendMessage: (
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<WAMessage | undefined>;
  sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
};

type WhatsAppSocketOperationTimeoutHooks = {
  onSendMessageTimeout?: (params: { jid: string; promise: Promise<WAMessage | undefined> }) => void;
};

const socketSendMessageQueueTails = new WeakMap<WhatsAppSocketOperationAdapter, Promise<void>>();

export const DEFAULT_WHATSAPP_SOCKET_TIMING: Required<WhatsAppSocketTimingOptions> = {
  keepAliveIntervalMs: 25_000,
  connectTimeoutMs: 60_000,
  defaultQueryTimeoutMs: 60_000,
};

class WhatsAppSocketOperationTimeoutError extends Error {
  readonly deliveryState = "unknown";

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`WhatsApp socket ${operation} timed out after ${timeoutMs}ms; delivery state is unknown`);
    this.name = "WhatsAppSocketOperationTimeoutError";
  }
}

export function resolveWhatsAppSocketTiming(
  cfg: OpenClawConfig,
  overrides?: WhatsAppSocketTimingOptions,
): Required<WhatsAppSocketTimingOptions> {
  const configured = cfg.web?.whatsapp;
  return {
    keepAliveIntervalMs:
      parseStrictPositiveInteger(overrides?.keepAliveIntervalMs) ??
      parseStrictPositiveInteger(configured?.keepAliveIntervalMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs,
    connectTimeoutMs:
      parseStrictPositiveInteger(overrides?.connectTimeoutMs) ??
      parseStrictPositiveInteger(configured?.connectTimeoutMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    defaultQueryTimeoutMs:
      parseStrictPositiveInteger(overrides?.defaultQueryTimeoutMs) ??
      parseStrictPositiveInteger(configured?.defaultQueryTimeoutMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
  };
}

export function isWhatsAppSocketOperationTimeoutError(
  error: unknown,
): error is WhatsAppSocketOperationTimeoutError {
  return error instanceof WhatsAppSocketOperationTimeoutError;
}

export function resolveWhatsAppSocketOperationTimeoutMs(timeoutMs: number): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
}

async function runSerializedSocketSendMessage<T>(
  sock: WhatsAppSocketOperationAdapter,
  run: () => Promise<T>,
): Promise<T> {
  const previous = socketSendMessageQueueTails.get(sock) ?? Promise.resolve();
  // Adapter instances are short-lived, so key the FIFO by the raw socket. A
  // bounded send releases the queue after timeout to avoid wedging later work.
  const result = previous.then(run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  socketSendMessageQueueTails.set(sock, tail);
  void tail.then(() => {
    if (socketSendMessageQueueTails.get(sock) === tail) {
      socketSendMessageQueueTails.delete(sock);
    }
  });
  return await result;
}

export async function withWhatsAppSocketOperationTimeout<T>(
  operation: string,
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  const resolvedTimeoutMs = resolveWhatsAppSocketOperationTimeoutMs(timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(new WhatsAppSocketOperationTimeoutError(operation, resolvedTimeoutMs));
        }, resolvedTimeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function createWhatsAppSocketOperationTimeoutAdapter(
  sock: WhatsAppSocketOperationAdapter,
  timeoutMs: number,
  hooks?: WhatsAppSocketOperationTimeoutHooks,
): WhatsAppSocketOperationAdapter {
  const operationTimeoutMs = resolveWhatsAppSocketOperationTimeoutMs(timeoutMs);
  return {
    sendMessage: (jid, content, options) => {
      return runSerializedSocketSendMessage(sock, () => {
        const send = options
          ? sock.sendMessage(jid, content, options)
          : sock.sendMessage(jid, content);
        return withWhatsAppSocketOperationTimeout(
          "sendMessage",
          send,
          operationTimeoutMs,
          hooks?.onSendMessageTimeout
            ? () => hooks.onSendMessageTimeout?.({ jid, promise: send })
            : undefined,
        );
      });
    },
    sendPresenceUpdate: (presence, jid) => {
      const send =
        jid === undefined
          ? sock.sendPresenceUpdate(presence)
          : sock.sendPresenceUpdate(presence, jid);
      return withWhatsAppSocketOperationTimeout("sendPresenceUpdate", send, operationTimeoutMs);
    },
  };
}
