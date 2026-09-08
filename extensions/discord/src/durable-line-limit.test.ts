// Exercises durable Discord line-limit resolution through the real local HTTP transport boundary.
import { ChannelType } from "discord-api-types/v10";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as threadBindings from "./monitor/thread-bindings.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

let discordPlugin: typeof import("./channel.js").discordPlugin;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;

const twentyLineText = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ sendMessageDiscord } = await import("./send.js"));
});

async function runDurableLineLimitScenario(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  structured?: boolean;
  webhook?: boolean;
  text?: string;
  replyToIdSource?: "implicit" | "explicit";
  replyToMode?: "first" | "all";
  formatting?: { maxLinesPerMessage?: number };
}) {
  let messageCount = 0;
  const loopback = await createDiscordLoopbackRest({
    respond: ({ method }) =>
      method === "GET"
        ? { id: "789", type: ChannelType.GuildText }
        : { id: `message-${++messageCount}`, channel_id: "789" },
  });
  const manager = threadBindings.createNoopThreadBindingManager(params.accountId);
  const binding = {
    accountId: params.accountId ?? "default",
    channelId: "789",
    threadId: "789",
    targetKind: "subagent" as const,
    targetSessionKey: "agent:main:subagent:fixture",
    agentId: "main",
    label: "Fixture persona",
    webhookId: "fixture-webhook",
    webhookToken: "fixture-webhook-token",
    boundBy: "fixture",
    boundAt: 1,
    lastActivityAt: 1,
  };
  const bindingSpy = vi
    .spyOn(threadBindings, "getThreadBindingManager")
    .mockReturnValue(params.webhook ? { ...manager, getByThreadId: () => binding } : null);
  const realFetch = globalThis.fetch.bind(globalThis);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "discord.com") {
      const target = new URL(expectDefined(loopback.rest.options.baseUrl, "loopback base URL"));
      target.pathname = url.pathname;
      target.search = url.search;
      return realFetch(target, init);
    }
    if (url.hostname !== "127.0.0.1") {
      throw new Error("Non-loopback test request");
    }
    return realFetch(input, init);
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: discordPlugin,
      },
    ]),
  );
  try {
    const result = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel: "discord",
      to: "channel:789",
      accountId: params.accountId,
      threadId: params.webhook ? "789" : undefined,
      identity: params.webhook
        ? { name: "Fixture persona", avatarUrl: "https://example.invalid/avatar.png" }
        : undefined,
      replyToId: "fixture-reply",
      replyToMode: params.replyToMode,
      payloads: [
        {
          text: params.text ?? twentyLineText,
          ...(params.replyToIdSource === "explicit" ? { replyToId: "fixture-reply" } : {}),
          ...(params.structured
            ? {
                channelData: {
                  execApproval: { approvalId: "proof-approval", approvalSlug: "proof-approval" },
                },
              }
            : {}),
        },
      ],
      formatting: params.formatting,
      deps: {
        discord: async (...[target, text, options]: Parameters<typeof sendMessageDiscord>) =>
          await sendMessageDiscord(target, text, {
            ...options,
            rest: loopback.rest,
            token: "fixture-token",
          }),
      },
      skipQueue: true,
    });
    const posted = loopback.requests
      .filter((request) => request.method === "POST")
      .map(
        (request) =>
          JSON.parse(request.body) as {
            content?: string;
            message_reference?: { message_id?: string };
          },
      );
    const chunks = posted.map((body) => body.content ?? "");
    const replies = posted.map((body) => body.message_reference?.message_id);
    if (params.webhook) {
      const posts = loopback.requests.filter((request) => request.method === "POST");
      expect(posts.every((request) => request.path?.includes("/webhooks/fixture-webhook/"))).toBe(
        true,
      );
      expect(posts.every((request) => request.path?.includes("thread_id=789"))).toBe(true);
      for (const post of posts) {
        expect(JSON.parse(post.body)).toMatchObject({
          username: "Fixture persona",
          avatar_url: "https://example.invalid/avatar.png",
        });
      }
    }
    return { chunks, replies, result };
  } finally {
    fetchSpy.mockRestore();
    bindingSpy.mockRestore();
    await loopback.close();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
}

describe("durable Discord configured line limits", () => {
  it("uses the selected account limit for structured payload fallback text", async () => {
    const { chunks, result } = await runDurableLineLimitScenario({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 10,
            accounts: { work: { token: "fixture-token", maxLinesPerMessage: 50 } },
          },
        },
      },
      accountId: "work",
      structured: true,
    });

    expect(result.status).toBe("sent");
    expect(chunks).toEqual([twentyLineText]);
  });
});

describe.each([false, true])("durable Discord transport webhook=%s", (webhook) => {
  it.each([
    {
      name: "default 17",
      root: undefined,
      account: undefined,
      explicit: undefined,
      counts: [17, 3],
    },
    { name: "root limit", root: 10, account: undefined, explicit: undefined, counts: [10, 10] },
    { name: "account wins", root: 5, account: 50, explicit: undefined, counts: [20] },
    { name: "explicit smaller", root: 10, account: 50, explicit: 5, counts: [5, 5, 5, 5] },
    { name: "explicit larger", root: 5, account: 10, explicit: 50, counts: [20] },
  ])("preserves $name at the HTTP boundary", async ({ root, account, explicit, counts }) => {
    const { chunks, result } = await runDurableLineLimitScenario({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: root,
            accounts: {
              work: {
                token: "fixture-token",
                ...(account === undefined ? {} : { maxLinesPerMessage: account }),
              },
            },
          },
        },
      },
      accountId: "work",
      webhook,
      formatting: explicit === undefined ? undefined : { maxLinesPerMessage: explicit },
    });
    expect(result.status).toBe("sent");
    expect(chunks.map((chunk) => chunk.split("\n").length)).toEqual(counts);
    expect(chunks.join("\n")).toBe(twentyLineText);
  });
  it.each([
    { replyToIdSource: "implicit", replyToMode: "first", repeat: false },
    { replyToIdSource: "explicit", replyToMode: "first", repeat: true },
    { replyToIdSource: "implicit", replyToMode: "all", repeat: true },
  ] as const)(
    "preserves $replyToIdSource $replyToMode-mode replies across physical chunks",
    async ({ replyToIdSource, replyToMode, repeat }) => {
      const { chunks, replies, result } = await runDurableLineLimitScenario({
        cfg: { channels: { discord: { token: "fixture-token" } } },
        webhook,
        replyToIdSource,
        replyToMode,
      });
      expect(result.status).toBe("sent");
      expect(chunks.map((chunk) => chunk.split("\n").length)).toEqual([17, 3]);
      expect(replies).toEqual(["fixture-reply", repeat ? "fixture-reply" : undefined]);
    },
  );
  it("preserves fenced code and character limits through durable delivery", async () => {
    const body = Array.from({ length: 20 }, (_, index) => `row-${index}: ${"x".repeat(130)}`).join(
      "\n",
    );
    const { chunks, result } = await runDurableLineLimitScenario({
      cfg: { channels: { discord: { token: "fixture-token", maxLinesPerMessage: 8 } } },
      webhook,
      text: `\`\`\`text\n${body}\n\`\`\``,
    });
    expect(result.status).toBe("sent");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```text\n") && chunk.endsWith("\n```"))).toBe(
      true,
    );
    let offset = 0;
    for (const chunk of chunks) {
      const content = chunk.split("\n").slice(1, -1).join("\n");
      expect(body.slice(offset, offset + content.length)).toBe(content);
      offset += content.length;
      // A character boundary can split inside a source line; only consume an original newline.
      if (body[offset] === "\n") {
        offset += 1;
      }
    }
    expect(offset).toBe(body.length);
  });
});
