import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMonitorContext } from "./context.js";

const enqueue = vi.hoisted(() => vi.fn(async (_entry: unknown) => {}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundDebouncer: () => ({
    debounceMs: 0,
    debouncer: {
      enqueue,
      flushKey: async () => {},
      cancelKey: () => false,
      drain: async () => {},
    },
  }),
}));

const { createSlackMessageHandler } = await import("./message-handler.js");

describe("Slack message handler thread resolution", () => {
  it("coalesces Enterprise lookups and retains separate caches for replacement and default clients", async () => {
    enqueue.mockClear();
    const requests: Array<{ path?: string; token?: string; body: string }> = [];
    await withServer(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          requests.push({
            path: request.url,
            token: request.headers.authorization,
            body: Buffer.concat(chunks).toString("utf8"),
          });
          const root = request.headers.authorization?.endsWith("replacement") ? "100.2" : "100.1";
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, messages: [{ ts: "100.3", thread_ts: root }] }));
        });
      },
      async (baseUrl) => {
        const client = (token: string) =>
          new WebClient(token, {
            slackApiUrl: `${baseUrl}/api/`,
            retryConfig: { retries: 0 },
          });
        const app = new App({
          token: "synthetic-default",
          signingSecret: "synthetic-signing-secret",
          tokenVerificationEnabled: false,
          clientOptions: {
            slackApiUrl: `${baseUrl}/api/`,
            retryConfig: { retries: 0 },
          },
        });
        const listenerClient = client("synthetic-listener");
        const replacementClient = client("synthetic-replacement");
        const handler = createSlackMessageHandler({
          ctx: createSlackMonitorContext({
            cfg: {},
            accountId: "thread-test",
            app,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            botToken: "synthetic-default",
            botUserId: "U111",
            identityHealth: { lifecycle: "ready", lastError: null },
            teamId: "T111",
            apiAppId: "A111",
            historyLimit: 0,
            sessionScope: "per-sender",
            mainKey: "main",
            dmEnabled: true,
            dmPolicy: "open",
            allowFrom: [],
            allowNameMatching: false,
            groupDmEnabled: false,
            groupDmChannels: [],
            groupPolicy: "open",
            useAccessGroups: true,
            reactionMode: "off",
            reactionAllowlist: [],
            replyToMode: "off",
            threadHistoryScope: "thread",
            threadInheritParent: false,
            slashCommand: {
              enabled: false,
              name: "openclaw",
              ephemeral: true,
              sessionPrefix: "slack:slash",
            },
            textLimit: 4000,
            typingReaction: "",
            mediaMaxBytes: 20 * 1024 * 1024,
          }),
          account: resolveSlackAccount({ cfg: {}, accountId: "thread-test" }),
        });
        const message: SlackMessageEvent = {
          type: "message",
          channel: "C111",
          user: "U111",
          parent_user_id: "U222",
          ts: "100.3",
          text: "thread reply",
        };
        const eventScope = { teamId: "T111", client: listenerClient };
        await Promise.all([
          handler(message, { source: "message", eventScope }),
          handler(message, { source: "app_mention", eventScope }),
        ]);
        await handler(message, { source: "message", eventScope });
        expect(requests).toHaveLength(1);
        expect(enqueue).toHaveBeenCalledTimes(3);
        for (const [entry] of enqueue.mock.calls) {
          expect(entry).toMatchObject({ message: { thread_ts: "100.1" } });
        }

        await handler(message, {
          source: "message",
          eventScope: { teamId: "T111", client: replacementClient },
        });
        expect(requests).toHaveLength(2);
        expect(enqueue).toHaveBeenLastCalledWith(
          expect.objectContaining({ message: expect.objectContaining({ thread_ts: "100.2" }) }),
        );

        await Promise.all([
          handler(message, { source: "message" }),
          handler(message, { source: "app_mention" }),
        ]);
        await handler(message, { source: "message" });
        expect(requests).toHaveLength(3);
        expect(requests.map((request) => request.token)).toEqual([
          "Bearer synthetic-listener",
          "Bearer synthetic-replacement",
          "Bearer synthetic-default",
        ]);
        for (const request of requests) {
          expect(request.path).toBe("/api/conversations.history");
          expect(Object.fromEntries(new URLSearchParams(request.body))).toMatchObject({
            channel: "C111",
            latest: "100.3",
            oldest: "100.3",
            inclusive: "true",
            limit: "1",
          });
        }
      },
    );
  });
});
