import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const shouldDebounceTextInboundMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn(
      (opts: { shouldDebounce: (entry: unknown) => boolean }) => ({
        debouncer: {
          enqueue: async (entry: unknown) => {
            opts.shouldDebounce(entry);
          },
        },
      }),
    ),
    shouldDebounceTextInbound: shouldDebounceTextInboundMock,
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

describe("iMessage plugin payload attachments", () => {
  beforeEach(() => {
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    shouldDebounceTextInboundMock.mockReset().mockReturnValue(false);
  });

  it("does not count Apple rich-link plugin payloads as user media", async () => {
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
              text: "https://example.com/article",
              attachments: [
                {
                  original_path:
                    "/Users/openclaw/Library/Messages/Attachments/AA/BB/link.pluginPayloadAttachment",
                  mime_type: null,
                  missing: false,
                  transfer_name: "link.pluginPayloadAttachment",
                  uti: "com.apple.messages.pluginPayloadAttachment",
                },
              ],
              is_group: false,
            },
          },
        });
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
        channels: { imessage: { includeAttachments: true, dmPolicy: "open" } },
        session: { mainKey: "main" },
      } as never,
    });

    expect(shouldDebounceTextInboundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "https://example.com/article",
        hasMedia: false,
      }),
    );
  });
});
