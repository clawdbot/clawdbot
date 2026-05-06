import type { WAMessage } from "@whiskeysockets/baileys";
import { extractText } from "./inbound/extract.js";
import { createWebSendApi } from "./inbound/send-api.js";
import { createWaSocket, waitForWaConnection } from "./session.js";
import { jidToE164 } from "./text-runtime.js";

export type WhatsAppQaDriverObservedMessage = {
  fromJid?: string;
  fromPhoneE164?: string | null;
  messageId?: string;
  observedAt: string;
  text: string;
};

export type WhatsAppQaDriverSession = {
  close: () => Promise<void>;
  getObservedMessages: () => WhatsAppQaDriverObservedMessage[];
  sendText: (to: string, text: string) => Promise<{ messageId?: string }>;
  waitForMessage: (params: {
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    timeoutMs: number;
  }) => Promise<WhatsAppQaDriverObservedMessage>;
};

type MessageUpsertEvent = {
  messages?: WAMessage[];
};

type Waiter = {
  predicate: (message: WhatsAppQaDriverObservedMessage) => boolean;
  reject: (error: Error) => void;
  resolve: (message: WhatsAppQaDriverObservedMessage) => void;
  timeout: NodeJS.Timeout;
};

function normalizeObservedMessage(
  message: WAMessage,
  authDir: string,
): WhatsAppQaDriverObservedMessage | null {
  if (message.key.fromMe) {
    return null;
  }
  const text = extractText(message.message ?? undefined);
  if (!text) {
    return null;
  }
  const fromJid = message.key.remoteJid ?? undefined;
  return {
    fromJid,
    fromPhoneE164: fromJid ? jidToE164(fromJid, { authDir }) : null,
    messageId: message.key.id ?? undefined,
    observedAt: new Date().toISOString(),
    text,
  };
}

function closeSocket(sock: Awaited<ReturnType<typeof createWaSocket>>) {
  const maybeEnd = (sock as unknown as { end?: (error?: Error) => void }).end;
  if (typeof maybeEnd === "function") {
    maybeEnd.call(sock);
    return;
  }
  const maybeClose = (sock.ws as unknown as { close?: () => void } | undefined)?.close;
  if (typeof maybeClose === "function") {
    maybeClose.call(sock.ws);
  }
}

export async function startWhatsAppQaDriverSession(params: {
  authDir: string;
  connectionTimeoutMs?: number;
}): Promise<WhatsAppQaDriverSession> {
  const sock = await createWaSocket(false, false, { authDir: params.authDir });
  const observedMessages: WhatsAppQaDriverObservedMessage[] = [];
  const waiters: Waiter[] = [];
  let closed = false;

  const removeWaiter = (waiter: Waiter) => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
    clearTimeout(waiter.timeout);
  };

  const observe = (message: WhatsAppQaDriverObservedMessage) => {
    observedMessages.push(message);
    for (const waiter of waiters.slice()) {
      if (!waiter.predicate(message)) {
        continue;
      }
      removeWaiter(waiter);
      waiter.resolve(message);
    }
  };

  const onMessagesUpsert = (event: MessageUpsertEvent) => {
    for (const rawMessage of event.messages ?? []) {
      const observed = normalizeObservedMessage(rawMessage, params.authDir);
      if (observed) {
        observe(observed);
      }
    }
  };

  const removeMessageListener = () => {
    const evWithOff = sock.ev as unknown as {
      off?: (event: string, listener: (event: MessageUpsertEvent) => void) => void;
    };
    evWithOff.off?.("messages.upsert", onMessagesUpsert);
  };

  const closeSessionResources = (waiterError?: Error) => {
    if (closed) {
      return;
    }
    closed = true;
    for (const waiter of waiters.slice()) {
      removeWaiter(waiter);
      if (waiterError) {
        waiter.reject(waiterError);
      }
    }
    removeMessageListener();
    closeSocket(sock);
  };

  sock.ev.on("messages.upsert", onMessagesUpsert);
  let connectionTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      waitForWaConnection(sock),
      new Promise<never>((_, reject) => {
        connectionTimeout = setTimeout(
          () => reject(new Error("timed out waiting for WhatsApp QA driver session")),
          params.connectionTimeoutMs ?? 45_000,
        );
        connectionTimeout.unref?.();
      }),
    ]);
  } catch (error) {
    closeSessionResources(
      error instanceof Error ? error : new Error("failed starting WhatsApp QA driver session"),
    );
    throw error;
  } finally {
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
    }
  }

  const sendApi = createWebSendApi({
    sock,
    defaultAccountId: "qa-driver",
  });

  return {
    async close() {
      closeSessionResources(new Error("WhatsApp QA driver session closed"));
    },
    getObservedMessages() {
      return [...observedMessages];
    },
    async sendText(to, text) {
      const result = await sendApi.sendMessage(to, text);
      return {
        messageId: result.messageId,
      };
    },
    async waitForMessage(params) {
      const existing = observedMessages.find(params.match);
      if (existing) {
        return existing;
      }
      return await new Promise<WhatsAppQaDriverObservedMessage>((resolve, reject) => {
        const waiter: Waiter = {
          predicate: params.match,
          resolve,
          reject,
          timeout: setTimeout(() => {
            removeWaiter(waiter);
            reject(new Error("timed out waiting for WhatsApp QA driver message"));
          }, params.timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}
