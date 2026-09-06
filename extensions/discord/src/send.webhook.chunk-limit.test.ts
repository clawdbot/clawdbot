import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { maybeSendBindingMessage } from "./monitor/thread-bindings.discord-api.js";
import type { ThreadBindingRecord } from "./monitor/thread-bindings.types.js";
import { discordOutbound } from "./outbound-adapter.js";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const realWebhookSend = sendWebhookMessageDiscord;
const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

async function withWebhookServer(
  reply: (content: string, index: number) => { status?: number; body: unknown },
  run: (contents: string[]) => Promise<void>,
) {
  const contents: string[] = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (part: string) => {
        body += part;
      });
      request.on("end", () => {
        const { content } = JSON.parse(body) as { content: string };
        contents.push(content);
        const next = reply(content, contents.length);
        response.writeHead(next.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(next.body));
      });
    },
    async (baseUrl) => {
      const realFetch = globalThis.fetch.bind(globalThis);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const original =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const target = new URL(original);
        target.protocol = "http:";
        target.host = new URL(baseUrl).host;
        return realFetch(target, init);
      });
      try {
        await run(contents);
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );
}

const cfg: OpenClawConfig = { channels: { discord: { token: "Bot test-token" } } };

describe("Discord webhook delivery", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
    hoisted.sendWebhookMessageDiscordMock.mockImplementation((...args) =>
      realWebhookSend(...(args as Parameters<typeof realWebhookSend>)),
    );
  });

  it.each([
    { label: "reasoning", text: `Reasoning:\n_${"a".repeat(4000)}_`, aliases: undefined },
    {
      label: "expanded mention",
      text: `${"a".repeat(1995)} @ops`,
      aliases: { ops: "123456789012345678" },
    },
  ])(
    "sends only transport-sized $label chunks to the real HTTP adapter",
    async ({ text, aliases }) => {
      await withWebhookServer(
        (content, index) =>
          content.length > 2000
            ? { status: 400, body: { code: 50035, message: "Invalid Form Body" } }
            : { body: { id: String(index), channel_id: "thread-1" } },
        async (contents) => {
          const chunks = chunkDiscordTextWithMode(text, {
            chunkMode: "length",
            maxChars: 2000,
            maxLines: 50,
          });
          const receipts: string[] = [];
          const progress: string[] = [];
          for (const chunk of chunks) {
            const result = await realWebhookSend(chunk, {
              cfg: { channels: { discord: { token: "Bot test-token", mentionAliases: aliases } } },
              webhookId: "123",
              webhookToken: "test-token",
              threadId: "thread-1",
              wait: true,
              onDeliveryResult: (part) => {
                progress.push(part.messageId);
              },
            });
            receipts.push(...(result.receipt?.platformMessageIds ?? []));
          }
          expect(contents.join("")).toBe(
            aliases ? `${"a".repeat(1995)} <@123456789012345678>` : chunks.join(""),
          );
          expect(contents.length).toBeGreaterThan(1);
          expect(contents.every((content) => content.length <= 2000)).toBe(true);
          expect(receipts).toEqual(contents.map((_, index) => String(index + 1)));
          expect(progress).toEqual(receipts);
        },
      );
    },
  );

  it.each(["adapter", "adapter with dispatch hook", "binding notification"] as const)(
    "does not send a second message after an ambiguous webhook result through %s",
    async (caller) => {
      await withWebhookServer(
        () => ({ status: 503, body: { message: "response lost after commit" } }),
        async (contents) => {
          if (caller === "binding notification") {
            const record = {
              accountId: "default",
              channelId: "parent-1",
              threadId: "thread-1",
              targetKind: "subagent",
              targetSessionKey: "agent:main:subagent:fixture",
              agentId: "main",
              boundBy: "fixture",
              boundAt: 1,
              lastActivityAt: 1,
              webhookId: "wh-1",
              webhookToken: "synthetic-token",
            } satisfies ThreadBindingRecord;
            await maybeSendBindingMessage({ cfg, record, text: "send once" });
          } else {
            mockDiscordBoundThreadManager(hoisted);
            await expect(
              discordOutbound.sendText?.({
                cfg,
                to: "channel:parent-1",
                threadId: "thread-1",
                text: "send once",
                ...(caller === "adapter with dispatch hook"
                  ? { onPlatformSendDispatch: async () => {} }
                  : {}),
              }),
            ).rejects.toThrow("response lost after commit");
          }
          expect(contents).toEqual(["send once"]);
          expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("retains an accepted chunk without replaying it when a later webhook chunk is rejected", async () => {
    mockDiscordBoundThreadManager(hoisted);
    const onDeliveryResult = vi.fn();
    await withWebhookServer(
      (_content, index) =>
        index === 1
          ? { body: { id: "accepted-1", channel_id: "thread-1" } }
          : { status: 404, body: { code: 10015, message: "Unknown Webhook" } },
      async (contents) => {
        await expect(
          discordOutbound.sendText?.({
            cfg,
            to: "channel:parent-1",
            threadId: "thread-1",
            text: "x".repeat(2001),
            onDeliveryResult,
          }),
        ).rejects.toThrow("Unknown Webhook");
        expect(contents.map((content) => content.length)).toEqual([2000, 1]);
        expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            channel: "discord",
            messageId: "accepted-1",
            target: { kind: "channel", id: "thread-1" },
            receipt: expect.objectContaining({ platformMessageIds: ["accepted-1"] }),
          }),
        );
        expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
      },
    );
  });
});
