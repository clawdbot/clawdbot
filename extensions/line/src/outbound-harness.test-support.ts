// Line test support shares the outbound runtime harness across send suites.
import { vi } from "vitest";
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
  return (options: { namespace: string }) => {
    const blobs = namespaces.get(options.namespace) ?? new Map<string, Uint8Array>();
    namespaces.set(options.namespace, blobs);
    const info = (key: string) => ({
      key,
      metadata: {},
      sizeBytes: blobs.get(key)?.byteLength ?? 0,
      createdAt: 0,
    });
    return {
      register: async (key: string, bytes: Uint8Array) => {
        blobs.set(key, bytes);
      },
      registerIfAbsent: async (key: string, bytes: Uint8Array) => {
        if (blobs.has(key)) {
          return false;
        }
        blobs.set(key, bytes);
        return true;
      },
      lookup: async (key: string) => {
        const bytes = blobs.get(key);
        return bytes ? { ...info(key), bytes } : undefined;
      },
      entries: async () => Array.from(blobs.keys(), info),
      delete: async (key: string) => blobs.delete(key),
      deleteExpiredKey: async () => undefined,
      deleteExpired: async () => [],
      clear: async () => {
        blobs.clear();
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
  pushTextMessageWithQuickReplies: ReturnType<typeof vi.fn>;
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
  const pushMessagesLine = vi.fn(async () => lineResult("m-batch"));
  const pushFlexMessage = vi.fn(async () => lineResult("m-flex"));
  const pushTemplateMessage = vi.fn(async () => lineResult("m-template"));
  const pushLocationMessage = vi.fn(async () => lineResult("m-loc"));
  const pushTextMessageWithQuickReplies = vi.fn(async () => lineResult("m-quick"));
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
