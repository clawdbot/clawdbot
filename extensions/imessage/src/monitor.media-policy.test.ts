// Imessage tests cover monitor.media policy plugin behavior.
import type { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { stageIMessageAttachments } from "./monitor/media-staging.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const stageIMessageAttachmentsMock = vi.hoisted(() => vi.fn<typeof stageIMessageAttachments>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn<typeof dispatchInboundMessage>(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
);

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

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
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
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    createIMessageRpcClientMock.mockReset();
    stageIMessageAttachmentsMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    dispatchInboundMessageMock.mockClear();
  });

  it("does not stage local attachments for messages dropped by inbound policy", async () => {
    stageIMessageAttachmentsMock.mockResolvedValue({ attachments: [], unavailableCount: 0 });
    readChannelAllowFromStoreMock.mockResolvedValue([]);

    const attachmentPath = "/Users/openclaw/Library/Messages/Attachments/AA/BB/photo.heic";
    let onNotification:
      | ((message: { method: string; params: unknown }) => void | Promise<void>)
      | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        void onNotification?.({
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
      includeAttachments: true,
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

    await vi.waitFor(() => expect(readChannelAllowFromStoreMock).toHaveBeenCalled());
    expect(stageIMessageAttachmentsMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "admits an attachment-only message when the image is unavailable",
      attachments: [
        {
          original_path: "/Users/openclaw/Library/Messages/Attachments/missing.heic",
          mime_type: "image/heic",
          missing: true,
        },
      ],
      staged: { attachments: [], unavailableCount: 1 },
      expectedBody: "[imessage attachment unavailable]",
    },
    {
      name: "uses the first materialized attachment type when earlier media is unavailable",
      attachments: [
        {
          original_path: "/Users/openclaw/Library/Messages/Attachments/missing.heic",
          mime_type: "image/heic",
          missing: true,
        },
        {
          original_path: "/Users/openclaw/Library/Messages/Attachments/report.pdf",
          mime_type: "application/pdf",
          missing: false,
        },
      ],
      staged: {
        attachments: [
          {
            path: "/Users/openclaw/Library/Messages/Attachments/report.pdf",
            contentType: "application/pdf",
          },
        ],
        unavailableCount: 1,
      },
      expectedBody: "<media:document>\n\n[imessage attachment unavailable]",
    },
  ])("$name", async ({ name, attachments, staged, expectedBody }) => {
    stageIMessageAttachmentsMock.mockResolvedValue(staged);
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    let onNotification:
      | ((message: { method: string; params: unknown }) => void | Promise<void>)
      | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        await onNotification?.({
          method: "message",
          params: {
            message: {
              id: 1,
              guid: `inbound-media-guid-${name}-${Date.now()}`,
              chat_id: 123,
              chat_identifier: "+15550001111",
              sender: "+15550001111",
              is_from_me: false,
              is_group: false,
              text: "",
              created_at: new Date().toISOString(),
              attachments,
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      includeAttachments: true,
      config: {
        channels: {
          imessage: {
            includeAttachments: true,
            attachmentRoots: ["/Users/openclaw/Library/Messages/Attachments"],
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
            groupPolicy: "open",
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stageIMessageAttachmentsMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1));
    expect(dispatchInboundMessageMock.mock.calls[0]?.[0].ctx.BodyForAgent).toBe(expectedBody);
  });
});
