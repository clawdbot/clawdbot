import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import {
  deleteQaBusMessage,
  editQaBusMessage,
  sendQaBusMessage,
  type QaBusMessage,
} from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import { createQaInboundParams, firstRunAssembledParams } from "./inbound.test-harness.js";

vi.mock("./bus-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bus-client.js")>()),
  deleteQaBusMessage: vi.fn(),
  editQaBusMessage: vi.fn(),
  sendQaBusMessage: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl: vi.fn(async () => ({
    buffer: Buffer.from("attachment"),
    kind: "file",
    contentType: "text/plain",
    fileName: "answer.txt",
  })),
}));

describe("QA reply preview lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["preview", "expanded preview"])(
    "orders partial %s and final delivery behind a pending preview deletion",
    async (partialText) => {
      const messages = new Map<string, QaBusMessage>();
      const deleted = new Set<string>();
      const deleteStarted = createDeferred<void>();
      const deleteAcknowledged = createDeferred<void>();
      const liveMessage = (id: string) => {
        const message = messages.get(id);
        if (!message || deleted.has(id)) {
          throw new Error(`message was deleted: ${id}`);
        }
        return message;
      };
      vi.mocked(sendQaBusMessage).mockImplementation(async (params) => {
        const message: QaBusMessage = {
          ...createQaInboundParams().message,
          id: `outbound-${messages.size + 1}`,
          direction: "outbound",
          text: params.text,
          attachments: params.attachments,
          toolCalls: params.toolCalls,
        };
        messages.set(message.id, message);
        return { message };
      });
      vi.mocked(editQaBusMessage).mockImplementation(async ({ messageId, text }) => {
        const message = liveMessage(messageId);
        message.text = text;
        return { message };
      });
      vi.mocked(deleteQaBusMessage).mockImplementation(async ({ messageId }) => {
        const message = liveMessage(messageId);
        deleted.add(messageId);
        deleteStarted.resolve();
        await deleteAcknowledged.promise;
        return { message };
      });

      const runtime = createPluginRuntimeMock();
      setQaChannelRuntime(runtime);
      await handleQaInbound(createQaInboundParams());
      const assembled = firstRunAssembledParams(runtime);
      await assembled.replyOptions?.onPartialReply?.({ text: "preview" });
      await assembled.replyOptions?.onToolStart?.({ phase: "start", name: "read" });
      const media = assembled.delivery.deliver({ mediaUrl: "/tmp/answer.txt" }, { kind: "block" });
      await deleteStarted.promise;
      const partial = assembled.replyOptions?.onPartialReply?.({ text: partialText });
      const final = assembled.delivery.deliver({ text: "final caption" }, { kind: "final" });
      const settled = Promise.allSettled([media, partial, final]);
      try {
        // Let detached callbacks advance while the server has deleted the preview
        // but its acknowledgement is still in flight.
        await Promise.resolve();
        await Promise.resolve();
        expect(editQaBusMessage).not.toHaveBeenCalled();
      } finally {
        deleteAcknowledged.resolve();
        await settled;
      }
      expect((await settled).map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ]);
      const visible = [...messages.values()].filter((message) => !deleted.has(message.id));
      expect(visible).toHaveLength(2);
      expect(visible[0]).toMatchObject({
        text: "",
        attachments: [{ contentBase64: Buffer.from("attachment").toString("base64") }],
      });
      expect(visible[1]).toMatchObject({
        text: "final caption",
        toolCalls: [{ name: "read" }],
      });
    },
  );
});
