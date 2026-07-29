// Whatsapp plugin module owns inbound debounce batching and flush lifecycle.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { getPrimaryIdentityId } from "../identity.js";
import { requireWhatsAppInboundAdmission } from "./admission.js";
import type { WhatsAppIngressLifecycle, WhatsAppReadReceiptTarget } from "./durable-receive.js";
import { attachWhatsAppIngressLifecycle } from "./ingress-lifecycle.js";
import { withDeprecatedWebInboundMessageFlatAliases } from "./message-aliases.js";
import type {
  AdmittedWebInboundMessage,
  WebInboundMessage,
  WebInboundMessageInput,
} from "./types.js";

type AdmittedWebInboundCallbackMessage = WebInboundMessage & {
  admission: AdmittedWebInboundMessage["admission"];
};

export type WhatsAppQueuedInboundMessage = AdmittedWebInboundCallbackMessage & {
  debounceKey?: string;
  debounceKeyTracked?: boolean;
  turnAdoptionLifecycle?: WhatsAppIngressLifecycle;
  readReceipt?: WhatsAppReadReceiptTarget;
  receiveOrder?: number;
};

export function createWhatsAppInboundMessageDebouncer(options: {
  debounceMs?: number;
  onMessage: (msg: WebInboundMessageInput) => Promise<void>;
  shouldDebounce?: (msg: WebInboundMessageInput) => boolean;
  markRead: (target: WhatsAppReadReceiptTarget | undefined) => Promise<void>;
  onPendingWorkChanged: () => void;
  onError: (error: unknown) => void;
}) {
  const debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 0));
  const pendingKeys = new Map<string, number>();
  const activeFlushes = new Set<Promise<void>>();
  // Close waits wake as soon as a queued key becomes flushable, avoiding
  // timer polling and preserving fake-timer shutdown behavior.
  const workWaiters = new Set<() => void>();
  const notifyWork = () => {
    const waiters = [...workWaiters];
    workWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  };
  const buildKey = (msg: WhatsAppQueuedInboundMessage): string | null => {
    const admission = requireWhatsAppInboundAdmission(msg);
    const sender = msg.platform.sender;
    const senderKey =
      admission.conversation.kind === "group"
        ? (getPrimaryIdentityId(sender ?? null) ??
          msg.platform.senderJid ??
          msg.platform.senderE164 ??
          msg.platform.senderName ??
          admission.sender.id)
        : admission.conversation.id;
    return senderKey ? `${admission.accountId}:${admission.conversation.id}:${senderKey}` : null;
  };
  const shouldDebounce = (msg: AdmittedWebInboundCallbackMessage): boolean =>
    options.shouldDebounce?.(msg) ?? true;
  const trackKey = (key: string) => {
    pendingKeys.set(key, (pendingKeys.get(key) ?? 0) + 1);
  };
  const releaseKey = (entry: WhatsAppQueuedInboundMessage) => {
    if (!entry.debounceKey || entry.debounceKeyTracked !== true) {
      return;
    }
    const remaining = (pendingKeys.get(entry.debounceKey) ?? 0) - 1;
    if (remaining > 0) {
      pendingKeys.set(entry.debounceKey, remaining);
    } else {
      pendingKeys.delete(entry.debounceKey);
    }
  };
  const orderEntries = (entries: WhatsAppQueuedInboundMessage[]) =>
    entries.toSorted((a, b) => {
      const timestampDiff = (a.event.timestamp ?? 0) - (b.event.timestamp ?? 0);
      return timestampDiff !== 0 ? timestampDiff : (a.receiveOrder ?? 0) - (b.receiveOrder ?? 0);
    });

  const debouncer = createInboundDebouncer<WhatsAppQueuedInboundMessage>({
    debounceMs,
    buildKey: (msg) => msg.debounceKey ?? buildKey(msg),
    shouldDebounce,
    onFlush: (entries, createFlush) => {
      for (const entry of entries) {
        releaseKey(entry);
      }
      const orderedEntries = orderEntries(entries);
      const { lifecycle, settle, abandon } = fanInChannelIngressLifecycles(
        orderedEntries.map((entry) => entry.turnAdoptionLifecycle),
      );
      const flush = createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          const last = orderedEntries.at(-1);
          if (!last) {
            return;
          }
          try {
            if (orderedEntries.length === 1) {
              await options.onMessage(attachWhatsAppIngressLifecycle(last, admissionLifecycle));
              await settle();
              await Promise.all(orderedEntries.map((entry) => options.markRead(entry.readReceipt)));
              return;
            }
            const mentioned = new Set<string>();
            for (const entry of orderedEntries) {
              for (const jid of entry.group?.mentions?.jids ?? []) {
                mentioned.add(jid);
              }
            }
            const combinedBody = orderedEntries
              .map((entry) => entry.payload.body)
              .filter(Boolean)
              .join("\n");
            const combinedCommandBody = orderedEntries
              .map((entry) => entry.payload.commandBody ?? entry.payload.body)
              .filter(Boolean)
              .join("\n");
            const combinedMentions =
              mentioned.size > 0
                ? { ...last.group?.mentions, jids: Array.from(mentioned) }
                : last.group?.mentions;
            const combinedGroup =
              last.group || combinedMentions
                ? { ...last.group, mentions: combinedMentions }
                : undefined;
            const combinedMessage: WhatsAppQueuedInboundMessage = attachWhatsAppIngressLifecycle(
              withDeprecatedWebInboundMessageFlatAliases({
                ...last,
                turnAdoptionLifecycle: admissionLifecycle,
                payload: {
                  ...last.payload,
                  body: combinedBody,
                  commandBody: combinedCommandBody,
                },
                group: combinedGroup,
                event: { ...last.event, isBatched: true },
              }),
              admissionLifecycle,
            );
            await options.onMessage(combinedMessage);
            await settle();
            await Promise.all(orderedEntries.map((entry) => options.markRead(entry.readReceipt)));
          } catch (error) {
            await abandon();
            throw error;
          }
        },
      });
      activeFlushes.add(flush.completion);
      options.onPendingWorkChanged();
      notifyWork();
      const cleanup = () => {
        activeFlushes.delete(flush.completion);
        options.onPendingWorkChanged();
      };
      void flush.completion.then(cleanup, cleanup);
      return flush;
    },
    onError: options.onError,
  });

  const enqueue = async (message: WhatsAppQueuedInboundMessage) => {
    const key = buildKey(message);
    if (key) {
      message.debounceKey = key;
      if (debounceMs > 0 && shouldDebounce(message)) {
        message.debounceKeyTracked = true;
        trackKey(key);
        options.onPendingWorkChanged();
        notifyWork();
      }
    }
    await debouncer.enqueue(message);
  };
  const hasPendingWork = () => pendingKeys.size > 0 || activeFlushes.size > 0;
  const pendingWorkCount = () => pendingKeys.size + activeFlushes.size;
  const waitForWorkOrIdle = (handlers: ReadonlyArray<Promise<void>>, handlersIdle: boolean) => {
    if (hasPendingWork() || handlersIdle) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        workWaiters.delete(finish);
        resolve();
      };
      workWaiters.add(finish);
      void Promise.allSettled(handlers).then(finish);
    });
  };
  const drain = async () => {
    while (hasPendingWork()) {
      const keys = Array.from(pendingKeys.keys());
      if (keys.length > 0) {
        await Promise.all(keys.map((key) => debouncer.flushKey(key)));
      }
      await debouncer.drain();
      await Promise.resolve();
    }
  };

  return {
    enqueue,
    drain,
    hasPendingWork,
    pendingWorkCount,
    waitForWorkOrIdle,
  } as const;
}
