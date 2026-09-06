import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { buildHistoryContext } from "openclaw/plugin-sdk/reply-history";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendMessageTelegram } from "./send.js";

describe("reply scaffolding through final preparation and Telegram HTTP", () => {
  let server: Server;
  let apiRoot: string;
  let messageSequence = 0;
  const sockets = new Set<Socket>();
  const delivered: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const fields = request.headers["content-type"]?.includes("application/json")
          ? (JSON.parse(body) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(body));
        if (request.url?.endsWith("/sendMessage")) {
          const text = typeof fields.text === "string" ? fields.text : "";
          delivered.push(text);
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id: delivered.length,
                date: 1_700_000_000,
                chat: { id: 123, type: "private" },
                text,
              },
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, description: "Unexpected Telegram API call" }));
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    delivered.length = 0;
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  async function prepareAndDispatch(payload: ReplyPayload, conversationContext?: string) {
    const errors: unknown[] = [];
    const cfg = {
      channels: {
        telegram: { botToken: "123456:telegram-plugin-http-fixture", apiRoot },
      },
    };
    const dispatcher = createReplyDispatcher({
      deliver: async (prepared) => {
        await sendMessageTelegram("123", prepared.text ?? "", { cfg });
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    if (conversationContext) {
      const messageId = `reply-scaffolding-${++messageSequence}`;
      await dispatchInboundMessage({
        cfg,
        ctx: {
          Body: conversationContext,
          BodyForAgent: conversationContext,
          ChatType: "direct",
          From: "123",
          MessageSid: messageId,
          Provider: "telegram",
          SessionKey: `agent:test:${messageId}`,
          Surface: "telegram",
          To: "456",
        },
        dispatcher,
        outboundHooks: "disabled",
        replyResolver: async () => payload,
      });
    } else {
      dispatcher.sendFinalReply(payload);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
    expect(errors).toEqual([]);
  }

  it("removes the full copied prompt before XML and metadata cleanup changes it", async () => {
    const conversationContext = buildHistoryContext({
      historyText: "[Telegram] Alice: private history paragraph",
      currentMessage: [
        "Conversation info: ⟦openclaw:ctx⟧",
        "```json",
        '{"private":"sender metadata"}',
        "```",
        '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
        "",
        "private second inbound paragraph",
      ].join("\n"),
    });

    await prepareAndDispatch(
      { text: `${conversationContext}\n\n${conversationContext}\n\nVisible answer.` },
      conversationContext,
    );

    expect(delivered).toEqual(["Visible answer."]);
  });

  it("preserves literal fenced scaffolding examples that do not copy the private prompt", async () => {
    const conversationContext = buildHistoryContext({
      historyText: "[Telegram] Alice: earlier message",
      currentMessage: "[Telegram] Alice: current message",
    });
    const literal = [
      "The prompt format is:",
      "",
      "```text",
      "[Chat messages since your last reply - for context]",
      "Example: this is public placeholder history.",
      "",
      "[Current message - respond to this]",
      "Example: this is a public placeholder message.",
      "```",
    ].join("\n");

    await prepareAndDispatch({ text: literal }, conversationContext);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("[Chat messages since your last reply - for context]");
    expect(delivered[0]).toContain("[Current message - respond to this]");
    expect(delivered[0]).toContain("Example: this is a public placeholder message.");
  });

  it("removes a copied prompt when the source and model normalize line endings differently", async () => {
    const conversationContext = buildHistoryContext({
      historyText: "[Telegram] Alice: private history",
      currentMessage: "private first paragraph\n\nprivate second paragraph",
      lineBreak: "\r\n",
    });

    await prepareAndDispatch(
      { text: `${conversationContext.replace(/\r\n/g, "\n")}\n\nVisible answer.` },
      conversationContext,
    );

    expect(delivered).toEqual(["Visible answer."]);
  });

  it("never delivers a copied prompt with bare carriage-return separators", async () => {
    const conversationContext = buildHistoryContext({
      historyText: "[Telegram] Alice: private history",
      currentMessage: "private inbound paragraph",
    });

    await prepareAndDispatch(
      { text: `${conversationContext.replace(/\n/g, "\r")}\n\nVisible answer.` },
      conversationContext,
    );

    expect(delivered).toEqual(["Visible answer."]);
  });

  it("never makes a Telegram HTTP request for empty internal exec output", async () => {
    await prepareAndDispatch({ text: "  (no output)\r\n" });

    expect(delivered).toEqual([]);
  });

  it("never delivers a copied prompt disguised with same-line wrappers", async () => {
    const conversationContext = buildHistoryContext({
      historyText: "[Telegram] Alice: private history",
      currentMessage: "private inbound paragraph",
    });

    await prepareAndDispatch(
      { text: `Visible prefix: ${conversationContext} visible suffix.` },
      conversationContext,
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("Visible prefix:");
    expect(delivered[0]).toContain("visible suffix.");
    expect(delivered[0]).not.toContain("private history");
    expect(delivered[0]).not.toContain("private inbound paragraph");
  });

  it("never delivers an exact private prompt hidden inside a Markdown code fence", async () => {
    const conversationContext = buildHistoryContext({
      historyText: "[Telegram] Alice: private history",
      currentMessage: "private inbound paragraph",
    });

    await prepareAndDispatch(
      { text: `\`\`\`text\n${conversationContext}\n\`\`\`\n\nVisible answer.` },
      conversationContext,
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("Visible answer.");
    expect(delivered[0]).not.toContain("private history");
    expect(delivered[0]).not.toContain("private inbound paragraph");
  });

  it.each([
    { name: "blockquoted", prefix: "> " },
    { name: "indented", prefix: "    " },
    { name: "bulleted", prefix: "- " },
    { name: "headed", prefix: "# " },
    { name: "list-continuation", prefix: "- ", continuation: "  " },
    { name: "wide-list-continuation", prefix: "- ", continuation: "    " },
    { name: "varying-quote-depth", prefix: "> ", continuation: ">> " },
  ])(
    "never delivers an exact private prompt $name on every Markdown line",
    async ({ prefix, continuation }) => {
      const conversationContext = buildHistoryContext({
        historyText: "[Telegram] Alice: private history",
        currentMessage: "private inbound paragraph",
      });
      const quotedContext = conversationContext
        .split("\n")
        .map((line, index) => `${index === 0 ? prefix : (continuation ?? prefix)}${line}`)
        .join("\n");

      await prepareAndDispatch(
        { text: `${quotedContext}\n\nVisible answer.` },
        conversationContext,
      );

      expect(delivered).toEqual(["Visible answer."]);
    },
  );
});
