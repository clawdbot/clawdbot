// Line test support shares the outbound runtime harness across send suites.
import { type Mock, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { createLineSendReceipt } from "./send-receipt.js";
import { resolveLinePushRetryKey } from "./send-retry.js";

/** In-memory stand-in for the plugin blob store the durable send plan persists to. */
export type LineBlobStoreFake = Map<string, Uint8Array>;

/** Runtime state slice backed by an in-memory store, shared by the durable suites. */
export function createLineBlobStoreState(): {
  state: { openBlobStore: ReturnType<typeof createBlobStoreOpener> };
  blobs: LineBlobStoreFake;
} {
  const namespaces = new Map<string, LineBlobStoreFake>();
  const blobs: LineBlobStoreFake = new Map();
  namespaces.set("outbound-send-plans", blobs);
  return { state: { openBlobStore: createBlobStoreOpener(namespaces) }, blobs };
}

function createBlobStoreOpener(namespaces: Map<string, LineBlobStoreFake>) {
  // Expiries live beside the bytes, per namespace, because production opens a new
  // store handle for every operation: holding them on the handle would drop each
  // entry's deadline the moment the store that recorded it went out of scope.
  const namespaceExpiries = new Map<string, Map<string, number>>();
  return (options: { namespace: string; defaultTtlMs?: number }) => {
    const blobs = namespaces.get(options.namespace) ?? new Map<string, Uint8Array>();
    namespaces.set(options.namespace, blobs);
    // The store this stands in for drops an entry once its TTL passes. Keeping
    // entries forever here would make every expiry-dependent assertion pass by
    // construction, including the window a recorded plan has to survive.
    const expiries = namespaceExpiries.get(options.namespace) ?? new Map<string, number>();
    namespaceExpiries.set(options.namespace, expiries);
    const isExpired = (key: string) => {
      const expiresAt = expiries.get(key);
      return expiresAt !== undefined && Date.now() >= expiresAt;
    };
    const drop = (key: string) => {
      blobs.delete(key);
      expiries.delete(key);
    };
    const live = (key: string) => {
      if (isExpired(key)) {
        drop(key);
      }
      return blobs.has(key);
    };
    const put = (key: string, bytes: Uint8Array, ttlMs?: number) => {
      blobs.set(key, bytes);
      const effectiveTtlMs = ttlMs ?? options.defaultTtlMs;
      if (effectiveTtlMs === undefined) {
        expiries.delete(key);
        return;
      }
      expiries.set(key, Date.now() + effectiveTtlMs);
    };
    const info = (key: string) => ({
      key,
      metadata: {},
      sizeBytes: blobs.get(key)?.byteLength ?? 0,
      createdAt: 0,
    });
    return {
      register: async (
        key: string,
        bytes: Uint8Array,
        _metadata?: unknown,
        entryOptions?: { ttlMs?: number },
      ) => {
        put(key, bytes, entryOptions?.ttlMs);
      },
      registerIfAbsent: async (
        key: string,
        bytes: Uint8Array,
        _metadata?: unknown,
        entryOptions?: { ttlMs?: number },
      ) => {
        if (live(key)) {
          return false;
        }
        put(key, bytes, entryOptions?.ttlMs);
        return true;
      },
      lookup: async (key: string) => {
        if (!live(key)) {
          return undefined;
        }
        const bytes = blobs.get(key);
        return bytes ? { ...info(key), bytes } : undefined;
      },
      entries: async () => Array.from(blobs.keys(), info).filter((entry) => live(entry.key)),
      delete: async (key: string) => {
        const existed = blobs.has(key);
        drop(key);
        return existed;
      },
      deleteExpiredKey: async (key: string) => {
        if (!isExpired(key)) {
          return undefined;
        }
        drop(key);
        return key;
      },
      deleteExpired: async () => {
        const expired = Array.from(blobs.keys()).filter(isExpired);
        for (const key of expired) {
          drop(key);
        }
        return expired;
      },
      clear: async () => {
        blobs.clear();
        expiries.clear();
      },
    };
  };
}

type LineRuntimeMocks = {
  blobs: LineBlobStoreFake;
  pushMessageLine: ReturnType<typeof vi.fn>;
  pushMessagesLine: ReturnType<typeof vi.fn>;
  pushFlexMessage: ReturnType<typeof vi.fn>;
  pushTemplateMessage: ReturnType<typeof vi.fn>;
  pushLocationMessage: ReturnType<typeof vi.fn>;
  pushTextMessageWithQuickReplies: Mock<typeof import("./send.js").pushTextMessageWithQuickReplies>;
  createQuickReplyItems: ReturnType<typeof vi.fn>;
  buildTemplateMessageFromPayload: ReturnType<typeof vi.fn>;
  sendMessageLine: ReturnType<typeof vi.fn>;
  chunkMarkdownText: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
  resolveTextChunkLimit: ReturnType<typeof vi.fn>;
};

export function lineResult(messageId: string, chatId = "c1") {
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, chatId, kind: "text" }),
  };
}

/**
 * The real push owner records every push before dispatching it. A stand-in that
 * skipped that would let a durable send look like a fan-out that reproduced
 * nothing, so the mocks honour the same callback contract.
 */
type StubbedPushOpts = {
  durableSend?: { deliveryQueueId?: string | null; partIndex?: number; pushIndex?: number };
  onDurablePush?: (push: {
    retryKey: string;
    messages: { type: string; text?: string }[];
  }) => Promise<void>;
};

async function recordStubbedPush(opts: StubbedPushOpts | undefined, text: string): Promise<void> {
  await opts?.onDurablePush?.({
    retryKey: resolveLinePushRetryKey(opts.durableSend ?? {}),
    messages: [{ type: "text", text }],
  });
}

export function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const pushMessageLine = vi.fn(async (_to: string, text: string, opts?: StubbedPushOpts) => {
    await recordStubbedPush(opts, text);
    return lineResult("m-text");
  });
  const pushMessagesLine = vi.fn(
    async (_to: string, _messages: unknown, opts?: StubbedPushOpts) => {
      await recordStubbedPush(opts, "m-batch");
      return lineResult("m-batch");
    },
  );
  const pushFlexMessage = vi.fn(
    async (_to: string, _alt: string, _contents: unknown, opts?: StubbedPushOpts) => {
      await recordStubbedPush(opts, "m-flex");
      return lineResult("m-flex");
    },
  );
  const pushTemplateMessage = vi.fn(
    async (_to: string, _alt: string, _t: unknown, opts?: StubbedPushOpts) => {
      await recordStubbedPush(opts, "m-template");
      return lineResult("m-template");
    },
  );
  const pushLocationMessage = vi.fn(async (_to: string, _loc: unknown, opts?: StubbedPushOpts) => {
    await recordStubbedPush(opts, "m-loc");
    return lineResult("m-loc");
  });
  const pushTextMessageWithQuickReplies = vi.fn<
    typeof import("./send.js").pushTextMessageWithQuickReplies
  >(async () => lineResult("m-quick"));
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
  const buildTemplateMessageFromPayload = vi.fn(() => ({ type: "buttons" }));
  const sendMessageLine = vi.fn(async () => lineResult("m-media"));
  const chunkMarkdownText = vi.fn((text: string) => [text]);
  const resolveTextChunkLimit = vi.fn(() => 123);
  const resolveLineAccount = vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const resolved = accountId ?? "default";
      const lineConfig = (cfg.channels?.line ?? {}) as {
        accounts?: Record<string, Record<string, unknown>>;
      };
      const accountConfig = resolved !== "default" ? (lineConfig.accounts?.[resolved] ?? {}) : {};
      return {
        accountId: resolved,
        config: { ...lineConfig, ...accountConfig },
      };
    },
  );

  const { state, blobs } = createLineBlobStoreState();

  const runtime = {
    state,
    channel: {
      line: {
        pushMessageLine,
        pushMessagesLine,
        pushFlexMessage,
        pushTemplateMessage,
        pushLocationMessage,
        pushTextMessageWithQuickReplies,
        createQuickReplyItems,
        buildTemplateMessageFromPayload,
        sendMessageLine,
        resolveLineAccount,
      },
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
      },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    mocks: {
      blobs,
      pushMessageLine,
      pushMessagesLine,
      pushFlexMessage,
      pushTemplateMessage,
      pushLocationMessage,
      pushTextMessageWithQuickReplies,
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      sendMessageLine,
      chunkMarkdownText,
      resolveLineAccount,
      resolveTextChunkLimit,
    },
  };
}
