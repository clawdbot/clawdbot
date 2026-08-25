import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendMessageTelegram } from "../../../extensions/telegram/runtime-api.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { buildHistoryContext } from "./history.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

describe("reply scaffolding through final preparation and Telegram HTTP", () => {
  let server: Server;
  let apiRoot: string;
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
    const dispatcher = createReplyDispatcher({
      deliver: async (prepared) => {
        await sendMessageTelegram("123", prepared.text ?? "", {
          cfg: {
            channels: {
              telegram: { botToken: "123456:telegram-http-fixture", apiRoot },
            },
          },
        });
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    const { replyPayloads } = await buildReplyPayloads({
      payloads: [payload],
      conversationContext,
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
    });
    for (const prepared of replyPayloads) {
      dispatcher.sendFinalReply(prepared);
    }
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(errors).toEqual([]);
  }

  it("removes the full copied prompt before XML and metadata cleanup changes it", async () => {
    const conversationContext = buildHistoryContext({
      historyText: "[Telegram] Alice: private history paragraph",
      currentMessage: [
        markInboundContextLabel("Conversation info:"),
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
});
