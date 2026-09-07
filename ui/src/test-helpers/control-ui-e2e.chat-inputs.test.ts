/* @vitest-environment jsdom */
import { expect } from "vitest";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGateway,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it.for([false, true])(
  "commits default chat input before model execution (attachment: %s)",
  async (attachment, { gatewayPage }) => {
    gatewayPage.execute(
      createControlUiMockGatewayInitScript({
        historyMessages: [
          { role: "assistant", content: "Ready", __openclaw: { id: "ready", seq: 4 } },
        ],
      }),
    );
    const { request, frames } = gatewayPage.connect();
    await flushMockTimers();
    const params = {
      sessionKey: "agent:main:main",
      message: "Keep the submitted source",
      idempotencyKey: "source-run",
      ...(attachment
        ? {
            attachments: [
              { type: "file", fileName: "source.txt", mimeType: "text/plain", content: "aGVsbG8=" },
            ],
          }
        : {}),
    };
    const ack = await request("send", "chat.send", params);
    const history = await request("history", "chat.history", {
      sessionKey: params.sessionKey,
      inputRunIds: ["source-run", "unknown"],
    });
    expect(history.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "Ready" }),
      expect.objectContaining({
        role: "user",
        content: params.message,
        idempotencyKey: "source-run:user",
        __openclaw: expect.objectContaining({ id: "mock-user:source-run", seq: 5 }),
      }),
    ]);
    expect(history.inputReceipts).toEqual([
      { runId: "source-run", state: "consumed", consumedByEventId: "mock-user:source-run" },
    ]);
    expect(ack.status).toBe("started");
    if (attachment) {
      expect(ack).not.toHaveProperty("messageSeq");
      const event = frames.findIndex(
        (frame) => frame.type === "event" && frame.event === "session.message",
      );
      expect(event).toBeGreaterThan(frames.findIndex((frame) => frame.id === "send"));
      expect(
        (history.messages as Array<{ __openclaw?: unknown }>)[1]?.["__openclaw"],
      ).toMatchObject({
        media: [
          {
            fileName: "source.txt",
            contentType: "text/plain",
            url: "data:text/plain;base64,aGVsbG8=",
          },
        ],
      });
    } else {
      expect(ack.messageSeq).toBe(5);
    }
    await request("retry", "chat.send", params);
    expect(
      (await request("again", "chat.history", { sessionKey: params.sessionKey })).messages,
    ).toEqual(history.messages);
    const other = await request("other", "chat.history", {
      sessionKey: "agent:main:other",
      inputRunIds: ["source-run"],
    });
    expect(other.inputReceipts).toEqual([]);
    expect(other.messages).toHaveLength(1);
  },
);

it("does not invent consumption for held, explicitly resolved, or raw terminal inputs", async ({
  gatewayPage,
}) => {
  const { window, execute } = gatewayPage;
  execute(createControlUiMockGatewayInitScript({ deferredMethods: ["chat.send"] }));
  const gateway = (window as typeof window & { openclawControlUiE2eGateway: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  const { request, send } = gatewayPage.connect();
  await flushMockTimers();
  send("held", "chat.send", {
    sessionKey: "agent:main:main",
    message: "Unconfirmed source",
    idempotencyKey: "held-run",
  });
  const query = { sessionKey: "agent:main:main", inputRunIds: ["held-run"] };
  expect(await request("before", "chat.history", query)).toMatchObject({
    messages: [],
    inputReceipts: [],
  });
  gateway.resolveDeferred("chat.send", { runId: "held-run", status: "started" });
  gateway.emit("chat", { sessionKey: query.sessionKey, runId: "held-run", state: "final" });
  expect(await request("after", "chat.history", query)).toMatchObject({
    messages: [],
    inputReceipts: [],
  });
});

it("keeps an explicit display snapshot separate from durable input receipts", async ({
  gatewayPage,
}) => {
  const { window, execute } = gatewayPage;
  execute(createControlUiMockGatewayInitScript());
  const gateway = (window as typeof window & { openclawControlUiE2eGateway: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  const { request } = gatewayPage.connect();
  await flushMockTimers();
  await request("send", "chat.send", {
    sessionKey: "agent:main:main",
    message: "Committed original",
    idempotencyKey: "committed-run",
  });
  const messages = [{ role: "assistant", content: "An intentionally older display snapshot" }];
  gateway.setHistoryMessages(messages);
  expect(
    await request("history", "chat.history", {
      sessionKey: "agent:main:main",
      inputRunIds: ["committed-run"],
    }),
  ).toMatchObject({
    messages,
    inputReceipts: [
      { runId: "committed-run", state: "consumed", consumedByEventId: "mock-user:committed-run" },
    ],
  });
  const next = await request("next", "chat.send", {
    sessionKey: "agent:main:main",
    message: "Next committed source",
    idempotencyKey: "next-run",
  });
  expect(next.messageSeq).toBe(2);
});
