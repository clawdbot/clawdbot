import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Api } from "grammy";
import { buildHistoryContext } from "openclaw/plugin-sdk/reply-history";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";
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
        if (request.url?.endsWith("/sendMessage") || request.url?.endsWith("/editMessageText")) {
          const text = typeof fields.text === "string" ? fields.text : "";
          delivered.push(text);
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id:
                  typeof fields.message_id === "number" ? fields.message_id : delivered.length,
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

  async function prepareAndDispatch(
    payload: ReplyPayload,
    conversationContext?: string,
    reasoningSnapshots: readonly string[] = [],
  ) {
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
    const preview = reasoningSnapshots.length
      ? createTelegramDraftStream({
          api: new Api(cfg.channels.telegram.botToken, { apiRoot }),
          chatId: 123,
          renderText: (text) => ({ text, markdownSource: { text } }),
        })
      : undefined;
    try {
      if (conversationContext || preview) {
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
          replyOptions: preview
            ? {
                onReasoningStream: async ({ text }) => {
                  const { reasoningText } = splitTelegramReasoningText(text, true);
                  if (reasoningText) {
                    preview.update(reasoningText);
                    await preview.flush();
                  }
                },
              }
            : undefined,
          replyResolver: async (_ctx, options) => {
            for (const text of reasoningSnapshots) {
              await options?.onReasoningStream?.({ text, isReasoningSnapshot: true });
            }
            return payload;
          },
        });
      } else {
        dispatcher.sendFinalReply(payload);
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
      expect(errors).toEqual([]);
    } finally {
      await preview?.discard();
    }
  }

  it.each([false, true])(
    "cleans reasoning previews before Telegram HTTP (visible=%s)",
    async (visible) => {
      const opening = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
      const internal = `${opening}\nprivate runtime metadata\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
      const snapshots = [opening.slice(0, 20), `${opening}\nprivate runtime metadata`, internal];
      if (visible) {
        snapshots.push(
          `${internal}\n\nChecking files.`,
          `${internal}\n\nReading config.\n\nChecking files.`,
        );
      }
      await prepareAndDispatch({ text: "Visible answer." }, "Show status.", snapshots);
      expect(delivered).toEqual(
        visible
          ? [
              "🧠 <i>Checking files.</i>",
              "🧠 <i>Reading config.</i>\n\n<i>Checking files.</i>",
              "Visible answer.",
            ]
          : ["Visible answer."],
      );
    },
  );

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

  it("never delivers the internal runtime-context envelope in Telegram HTTP text", async () => {
    const leaked = [
      "Use it to continue answering the active user request now. Do not wait for",
      "another message. This context is runtime-generated, not user-authored.",
      "Keep internal details private.",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "Conversation info: (openclaw:ctx)",
      '{"chat_id":"telegram:123","message_id":"925"}',
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      "",
      "Visible answer.",
    ].join("\n");

    await prepareAndDispatch({ text: leaked });

    expect(delivered).toEqual(["Visible answer."]);
    expect(delivered.join("\n")).not.toContain("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>");
    expect(delivered.join("\n")).not.toContain("Keep internal details private.");
  });

  it("still delivers ordinary user-visible Telegram text", async () => {
    await prepareAndDispatch({ text: "Hello from Telegram." });

    expect(delivered).toEqual(["Hello from Telegram."]);
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
