import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { stageIMessageAttachments } from "./monitor/media-staging.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const stageIMessageAttachmentsMock = vi.hoisted(() => vi.fn<typeof stageIMessageAttachments>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    recordInboundSession: vi.fn(),
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn((opts) => ({
      debouncer: {
        enqueue: async (entry: unknown) => await opts.onFlush([entry]),
      },
    })),
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

vi.mock("./monitor/media-staging.js", () => ({
  stageIMessageAttachments: stageIMessageAttachmentsMock,
}));

describe("iMessage monitor attachment policy", () => {
  it("does not stage local attachments for messages dropped by inbound policy", async () => {
    stageIMessageAttachmentsMock.mockResolvedValue([]);
    readChannelAllowFromStoreMock.mockResolvedValue([]);

    const attachmentPath = "/Users/openclaw/Library/Messages/Attachments/AA/BB/photo.heic";
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 1,
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              is_group: true,
              text: "no mention here",
              attachments: [
                {
                  original_path: attachmentPath,
                  mime_type: "image/heic",
                  missing: false,
                },
              ],
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            includeAttachments: true,
            attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
            dmPolicy: "open",
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
        messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
        session: { mainKey: "main" },
      } as never,
    });

    expect(readChannelAllowFromStoreMock).toHaveBeenCalled();
    expect(stageIMessageAttachmentsMock).not.toHaveBeenCalled();
  });
});
