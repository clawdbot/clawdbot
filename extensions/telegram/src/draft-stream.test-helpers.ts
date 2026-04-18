import { vi } from "vitest";

type DraftPreviewMode = "message" | "draft";

export type TestDraftStream = {
  update: ReturnType<typeof vi.fn<(text: string) => void>>;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  messageId: ReturnType<typeof vi.fn<() => number | undefined>>;
  previewMode: ReturnType<typeof vi.fn<() => DraftPreviewMode>>;
  previewRevision: ReturnType<typeof vi.fn<() => number>>;
  lastDeliveredText: ReturnType<typeof vi.fn<() => string>>;
  clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  discard: ReturnType<typeof vi.fn<() => Promise<void>>>;
  materialize: ReturnType<typeof vi.fn<() => Promise<number | undefined>>>;
  forceNewMessage: ReturnType<typeof vi.fn<() => void>>;
  sendMayHaveLanded: ReturnType<typeof vi.fn<() => boolean>>;
  setMessageId: (value: number | undefined) => void;
};

export function createTestDraftStream(params?: {
  messageId?: number;
  previewMode?: DraftPreviewMode;
  onUpdate?: (text: string) => void;
  onStop?: () => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
  clearMessageIdOnForceNew?: boolean;
}): TestDraftStream {
  let messageId = params?.messageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  return {
    update: vi.fn().mockImplementation((text: string) => {
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
      params?.onUpdate?.(text);
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => messageId),
    previewMode: vi.fn().mockReturnValue(params?.previewMode ?? "message"),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      await params?.onStop?.();
    }),
    discard: vi.fn().mockImplementation(async () => {
      await params?.onDiscard?.();
    }),
    materialize: vi.fn().mockImplementation(async () => messageId),
    forceNewMessage: vi.fn().mockImplementation(() => {
      if (params?.clearMessageIdOnForceNew) {
        messageId = undefined;
      }
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      messageId = value;
    },
  };
}

export function createSequencedTestDraftStream(startMessageId = 1001): TestDraftStream {
  let activeMessageId: number | undefined;
  let nextMessageId = startMessageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  return {
    update: vi.fn().mockImplementation((text: string) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
      }
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => activeMessageId),
    previewMode: vi.fn().mockReturnValue("message"),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    materialize: vi.fn().mockImplementation(async () => activeMessageId),
    forceNewMessage: vi.fn().mockImplementation(() => {
      activeMessageId = undefined;
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      activeMessageId = value;
    },
  };
}
