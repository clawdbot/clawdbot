// Msteams test helpers build the SDK stream doubles both reply-stream-controller suites
// drive, so the streaming behavior and its presentation behavior assert against one shape.
import { vi } from "vitest";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

type StreamCloseResult = { id: string } | undefined;

export function makeStream() {
  return {
    emit: vi.fn(),
    update: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn<() => Promise<StreamCloseResult>>(async () => ({ id: "stream-final" })),
    canceled: false,
  };
}

export function makeAcknowledgedStream() {
  type ChunkActivity = {
    id?: string;
    type?: string;
    text?: string;
    channelData?: { streamType?: string };
  };
  const handlers = new Map<number, (activity: ChunkActivity) => void>();
  let nextSubscriptionId = 0;
  const stream = {
    ...makeStream(),
    events: {
      on: vi.fn((_event: "chunk", handler: (activity: ChunkActivity) => void) => {
        const subscriptionId = nextSubscriptionId++;
        handlers.set(subscriptionId, handler);
        return subscriptionId;
      }),
      off: vi.fn((subscriptionId: number) => {
        handlers.delete(subscriptionId);
      }),
    },
    acknowledge(text: string, overrides: Partial<ChunkActivity> = {}) {
      const activity: ChunkActivity = {
        id: "stream-acknowledged",
        type: "typing",
        text,
        channelData: { streamType: "streaming" },
        ...overrides,
      };
      for (const handler of handlers.values()) {
        handler(activity);
      }
    },
  };
  return stream;
}

export function makeContext(stream?: ReturnType<typeof makeStream>) {
  return { activity: { type: "message" }, stream } as never;
}

export function makeController(
  opts: {
    allowProviderPreview?: boolean;
    conversationType?: string;
    stream?: ReturnType<typeof makeStream>;
  } = {},
) {
  const stream = opts.stream;
  return createTeamsReplyStreamController({
    allowProviderPreview: opts.allowProviderPreview ?? true,
    conversationType: opts.conversationType ?? "personal",
    context: makeContext(stream),
    feedbackLoopEnabled: false,
  });
}
