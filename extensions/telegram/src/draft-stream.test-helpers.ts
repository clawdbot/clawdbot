// Telegram helper module supports draft stream helpers behavior.
import { vi } from "vitest";
import type { TelegramDraftMessageSnapshot, TelegramDraftPreview } from "./draft-stream.js";

type TestDraftStream = {
  update: ReturnType<typeof vi.fn<(text: string) => void>>;
  updatePreview: ReturnType<typeof vi.fn<(preview: TelegramDraftPreview) => void>>;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  messageId: ReturnType<typeof vi.fn<() => number | undefined>>;
  lastDeliveredText: ReturnType<typeof vi.fn<() => string>>;
  currentMessageSnapshot: ReturnType<typeof vi.fn<() => TelegramDraftMessageSnapshot | undefined>>;
  clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  discard: ReturnType<typeof vi.fn<() => Promise<void>>>;
  finalizeToPreview: ReturnType<
    typeof vi.fn<(preview: TelegramDraftPreview) => Promise<number | undefined>>
  >;
  forceNewMessage: ReturnType<typeof vi.fn<() => void>>;
  rotateToNewMessageDeferringDelete: ReturnType<typeof vi.fn<() => number | undefined>>;
  sendMayHaveLanded: ReturnType<typeof vi.fn<() => boolean>>;
  remainingFinalContent: ReturnType<typeof vi.fn<() => TelegramDraftMessageSnapshot | undefined>>;
  hasConsumedReplyTarget: ReturnType<typeof vi.fn<() => boolean>>;
  setMessageId: (value: number | undefined) => void;
};

export function createTestDraftStream(params?: {
  messageId?: number;
  onUpdate?: (text: string) => void;
  onStop?: () => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
  clearMessageIdOnForceNew?: boolean;
  remainingFinalContent?: TelegramDraftMessageSnapshot;
  hasConsumedReplyTarget?: boolean;
  stopUpdatesOnDiscard?: boolean;
}): TestDraftStream {
  let messageId = params?.messageId;
  let lastDeliveredText = "";
  let stopped = false;
  return {
    update: vi.fn().mockImplementation((text: string) => {
      if (stopped) {
        return;
      }
      lastDeliveredText = text.trimEnd();
      params?.onUpdate?.(text);
    }),
    updatePreview: vi.fn().mockImplementation((preview: TelegramDraftPreview) => {
      if (stopped) {
        return;
      }
      lastDeliveredText = preview.text.trimEnd();
      params?.onUpdate?.(preview.text);
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => messageId),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    currentMessageSnapshot: vi
      .fn()
      .mockImplementation(() =>
        messageId != null && lastDeliveredText
          ? { text: lastDeliveredText, sourceText: lastDeliveredText }
          : undefined,
      ),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      await params?.onStop?.();
    }),
    discard: vi.fn().mockImplementation(async () => {
      if (params?.stopUpdatesOnDiscard) {
        stopped = true;
      }
      await params?.onDiscard?.();
    }),
    finalizeToPreview: vi.fn().mockImplementation(async (preview: TelegramDraftPreview) => {
      if (messageId == null) {
        return undefined;
      }
      lastDeliveredText = preview.text.trimEnd();
      stopped = true;
      return messageId;
    }),
    forceNewMessage: vi.fn().mockImplementation(() => {
      stopped = false;
      if (params?.clearMessageIdOnForceNew) {
        messageId = undefined;
      }
    }),
    rotateToNewMessageDeferringDelete: vi.fn().mockImplementation(() => {
      // Mirror forceNewMessage's message-id handling (a sequenced harness swaps
      // ids on the next send; the fixed harness keeps its id unless configured
      // otherwise) so the rewind semantics match; return the superseded id.
      const superseded = messageId;
      stopped = false;
      if (params?.clearMessageIdOnForceNew) {
        messageId = undefined;
      }
      return superseded;
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    remainingFinalContent: vi.fn().mockReturnValue(params?.remainingFinalContent),
    hasConsumedReplyTarget: vi.fn().mockReturnValue(params?.hasConsumedReplyTarget ?? false),
    setMessageId: (value: number | undefined) => {
      messageId = value;
    },
  };
}

export function createSequencedTestDraftStream(startMessageId = 1001): TestDraftStream {
  let activeMessageId: number | undefined;
  let nextMessageId = startMessageId;
  let lastDeliveredText = "";
  return {
    update: vi.fn().mockImplementation((text: string) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
      }
      lastDeliveredText = text.trimEnd();
    }),
    updatePreview: vi.fn().mockImplementation((preview: TelegramDraftPreview) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
      }
      lastDeliveredText = preview.text.trimEnd();
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => activeMessageId),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    currentMessageSnapshot: vi
      .fn()
      .mockImplementation(() =>
        activeMessageId != null && lastDeliveredText
          ? { text: lastDeliveredText, sourceText: lastDeliveredText }
          : undefined,
      ),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    finalizeToPreview: vi.fn().mockImplementation(async (preview: TelegramDraftPreview) => {
      if (activeMessageId == null) {
        return undefined;
      }
      lastDeliveredText = preview.text.trimEnd();
      return activeMessageId;
    }),
    forceNewMessage: vi.fn().mockImplementation(() => {
      activeMessageId = undefined;
    }),
    rotateToNewMessageDeferringDelete: vi.fn().mockImplementation(() => {
      const superseded = activeMessageId;
      activeMessageId = undefined;
      return superseded;
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    remainingFinalContent: vi.fn().mockReturnValue(undefined),
    hasConsumedReplyTarget: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      activeMessageId = value;
    },
  };
}
