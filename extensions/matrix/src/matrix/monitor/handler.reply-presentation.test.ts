import { shouldAckReaction } from "openclaw/plugin-sdk/channel-feedback";
// Matrix tests cover the handler's reply presentation wiring.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMatrixReplyPayload } from "../../outbound.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import { createTypingCallbacks, type ReplyPayload } from "./runtime-api.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "$draft1", roomId: "!room" })),
);
const reactMatrixMessageMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));

vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: vi.fn((text: string) => ({
    trimmedText: text.trim(),
    convertedText: text.trim(),
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
  })),
  reactMatrixMessage: reactMatrixMessageMock,
  resolveMatrixMentionsForBody: vi.fn(async () => ({})),
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
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
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockClear();
    reactMatrixMessageMock.mockClear();
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

  it.each([undefined, "off"] as const)(
    "applies current acknowledgement scope while preserving account override %s",
    async (accountScope) => {
      const cfg: CoreConfig = {
        messages: { ackReaction: "👀", ackReactionScope: "off" },
        channels: {
          matrix: {
            dm: { allowFrom: ["*"] },
            accounts: { ops: { ackReactionScope: accountScope } },
          },
        },
      };
      let currentConfig = cfg;
      const dispatchInboundMessage = vi.fn(async () => ({
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
      }));
      const { handler } = createMatrixHandlerTestHarness({
        cfg,
        currentConfig: () => currentConfig,
        shouldAckReaction,
        dispatchInboundMessage,
      });
      for (const [index, scope] of (["off", "all", "off"] as const).entries()) {
        currentConfig = { ...cfg, messages: { ...cfg.messages, ackReactionScope: scope } };
        const eventId = `$reload-${index}`;
        await handler(
          "!room:example.org",
          createMatrixTextMessageEvent({ eventId, body: "hello" }),
        );
        const reactions = reactMatrixMessageMock.mock.calls.filter((call) => call[1] === eventId);
        expect(reactions.some((call) => call[2] === "👀")).toBe(
          accountScope === undefined && scope === "all",
        );
      }
      expect(dispatchInboundMessage).toHaveBeenCalledTimes(3);
    },
  );

  it("resolves a reply's presentation before the room delivery reads it", async () => {
    const runGate = createDeferred<void>();
    const captured = createDeferred<DeliverFn>();

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "off",
      createReplyDispatcherWithTyping: (params) => {
        captured.resolve((params as { deliver: DeliverFn }).deliver);
        return {
          dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        };
      },
      dispatchInboundMessage: vi.fn(async () => {
        await runGate.promise;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
    });

    const handlerDone = handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "deploy?" }),
    );
    const deliver = await captured.promise;
    try {
      await deliver(
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
    } finally {
      runGate.resolve();
      await handlerDone;
    }

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

  it("edits a matching live preview to attach the final reply's controls", async () => {
    const context = {
      cfg: { channels: { matrix: {} } },
      client: {} as MatrixClient,
      roomId: "!room:example.org",
      accountId: "ops",
      streaming: "partial" as const,
      replyToMode: "off" as const,
      logVerboseMessage: vi.fn(),
    };
    const draftController = await createMatrixDraftController({
      ...context,
      messageId: "$msg1",
      previewToolProgressEnabled: false,
    });
    const draftStream = draftController.draftStream;
    if (!draftStream) {
      throw new Error("partial streaming must create a draft stream");
    }
    const finalizeLive = vi.spyOn(draftStream, "finalizeLive");
    const typingCallbacks = createTypingCallbacks({
      start: async () => {},
      onStartError: vi.fn(),
    });
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Approve", action: { type: "callback" as const, value: "approve" } }],
        },
      ],
    };
    try {
      const payload = await prepareMatrixReplyPayload({ presentation });
      if (typeof payload.text !== "string") {
        throw new Error("prepared controls must have visible fallback text");
      }
      draftController.onPartialReply(payload.text);
      await draftStream.flush();
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(draftStream.matchesPreparedText(payload.text)).toBe(true);

      const { deliverReply } = createMatrixReplyDispatcher({
        ...context,
        draftStream,
        draftController,
        prefixOptions: { responsePrefixContextProvider: () => ({}) },
        humanDelay: undefined,
        typingCallbacks,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        mediaLocalRoots: [],
      });
      const result = await deliverReply(payload, { kind: "final" });

      expect(editMessageMatrixMock).toHaveBeenCalledExactlyOnceWith(
        context.roomId,
        "$draft1",
        payload.text,
        expect.objectContaining({
          extraContent: {
            "com.openclaw.presentation": expect.objectContaining({
              type: "message.presentation",
              version: 1,
              blocks: presentation.blocks,
            }),
          },
        }),
      );
      expect(finalizeLive).not.toHaveBeenCalled();
      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ messageIds: ["$draft1"], visibleReplySent: true });
    } finally {
      await draftStream.discardPending();
      draftController.cancelProgressDraft();
      typingCallbacks.onCleanup?.();
      finalizeLive.mockRestore();
    }
  });
});
