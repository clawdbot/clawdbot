// Matrix tests cover the handler's reply presentation wiring.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { ReplyPayload } from "./runtime-api.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);

vi.mock("../send.js", () => ({
  editMessageMatrix: vi.fn(async () => "$edited"),
  prepareMatrixSingleText: vi.fn((text: string) => ({
    trimmedText: text.trim(),
    convertedText: text.trim(),
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
  })),
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: vi.fn(async () => ({})),
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: vi.fn(async () => ({ messageId: "$draft1", roomId: "!room" })),
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: vi.fn(async () => {}),
}));

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn());

vi.mock("./replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replies.js")>()),
  deliverMatrixReplies: deliverMatrixRepliesMock,
}));

type DeliverFn = (
  payload: ReplyPayload,
  info: { kind: "tool" | "block" | "final" },
) => Promise<unknown>;

describe("matrix monitor handler reply presentation", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime();
    sendMessageMatrixMock.mockClear();
    deliverMatrixRepliesMock.mockReset().mockResolvedValue({
      messageIds: ["$reply1"],
      receipt: {
        primaryPlatformMessageId: "$reply1",
        platformMessageIds: ["$reply1"],
        parts: [{ platformMessageId: "$reply1", kind: "text" as const, index: 0 }],
        sentAt: 1,
      },
      visibleReplySent: true,
      content: "delivered",
    });
  });

  it("resolves a reply's presentation before the room delivery reads it", async () => {
    let capturedDeliver: DeliverFn | undefined;
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let markCaptured: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "off",
      createReplyDispatcherWithTyping: (params) => {
        capturedDeliver = (params as { deliver?: DeliverFn } | undefined)?.deliver;
        markCaptured?.();
        return {
          dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        };
      },
      dispatchInboundMessage: vi.fn(async () => {
        await runGate;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
    });

    const handlerDone = handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "deploy?" }),
    );
    await captured;

    await capturedDeliver?.(
      {
        presentation: {
          blocks: [
            { type: "text", text: "Deploy to production?" },
            {
              type: "buttons",
              buttons: [{ label: "Approve", action: { type: "callback", value: "approve" } }],
            },
          ],
        },
      },
      { kind: "final" },
    );
    releaseRun?.();
    await handlerDone;

    const delivered = deliverMatrixRepliesMock.mock.calls.at(0)?.[0] as
      | { replies?: ReplyPayload[] }
      | undefined;
    const reply = delivered?.replies?.[0];
    expect(reply?.text).toContain("Deploy to production?");
    expect(reply?.presentation).toBeUndefined();
    expect(
      ((reply?.channelData?.matrix as { extraContent?: Record<string, unknown> } | undefined)
        ?.extraContent ?? {})["com.openclaw.presentation"],
    ).toMatchObject({ type: "message.presentation", version: 1 });
  });
});
