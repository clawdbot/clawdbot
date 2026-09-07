import { afterEach, describe, expect, it, vi } from "vitest";
import { config, json, message, roster, runtime, window } from "./discord.fixtures.js";
import { createDiscordSource } from "./index.js";

afterEach(() => vi.useRealTimers());

describe("Discord report source", () => {
  it("converts timestamps to cursors and snowflakes to timestamps at the collection boundary", async () => {
    const context = runtime((url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bot ${config.token}`);
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.get("after")).toBe("175928843960320000");
        expect(url.searchParams.get("limit")).toBe("100");
        return json([
          {
            id: "175928847299117063",
            author: { id: "30" },
            content: "  Full discussion content  ",
          },
        ]);
      }
      return undefined;
    });
    const result = await createDiscordSource(context).collect(config, window, roster);
    expect(result.messages).toEqual([
      {
        channelId: "20",
        parentChannelId: "20",
        channelName: "engineering",
        authorId: "30",
        authorIsBot: false,
        atMs: 1462015105796,
        content: "Full discussion content",
      },
    ]);
    expect(result.status.ok).toBe(true);
  });

  it("pages forward across reverse-ordered pages and stops at the exclusive upper bound", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      message(window.sinceMs + index + 1),
    );
    let pages = 0;
    const context = runtime((url) => {
      if (!url.pathname.endsWith("/messages")) {
        return undefined;
      }
      pages += 1;
      if (pages === 1) {
        return json(firstPage.toReversed());
      }
      expect(url.searchParams.get("after")).toBe(firstPage[99]?.id);
      return json([
        message(window.untilMs + 1),
        message(window.untilMs),
        message(window.sinceMs + 200),
        { ...message(window.sinceMs + 150), author: { id: "31", bot: true } },
        message(window.sinceMs + 130, "   \n  "),
      ]);
    });
    const result = await createDiscordSource(context).collect(config, window, roster);
    expect(pages).toBe(2);
    expect(result.messages).toHaveLength(101);
    expect(result.messages.map((entry) => entry.atMs)).toEqual([
      ...firstPage.map((entry) => Date.parse(entry.timestamp)),
      window.sinceMs + 200,
    ]);
    expect(result.messages.every((entry) => !entry.authorIsBot && entry.content.trim())).toBe(true);
  });

  it("rolls active and recent archived threads into configured parents and bounds archive paging", async () => {
    const archiveTimes = [window.untilMs + 1000, window.sinceMs + 1000, window.sinceMs - 1];
    let archivePages = 0;
    const context = runtime((url) => {
      if (url.pathname.endsWith("/threads/active")) {
        return json({
          threads: [
            { id: "22", parent_id: "20", name: "design" },
            { id: "90", parent_id: "99", name: "outside" },
          ],
        });
      }
      if (url.pathname.endsWith("/threads/archived/public")) {
        archivePages += 1;
        if (archivePages === 1) {
          return json({
            threads: [
              {
                id: "22",
                parent_id: "20",
                name: "design",
                thread_metadata: {
                  archive_timestamp: new Date(archiveTimes[0] ?? 0).toISOString(),
                },
              },
            ],
            has_more: true,
          });
        }
        expect(url.searchParams.get("before")).toBe(new Date(archiveTimes[0] ?? 0).toISOString());
        return json({
          threads: [
            {
              id: "21",
              parent_id: "20",
              name: "review",
              thread_metadata: { archive_timestamp: new Date(archiveTimes[1] ?? 0).toISOString() },
            },
            {
              id: "23",
              parent_id: "20",
              name: "old",
              thread_metadata: { archive_timestamp: new Date(archiveTimes[2] ?? 0).toISOString() },
            },
          ],
          has_more: true,
        });
      }
      if (url.pathname.endsWith("/messages")) {
        const channelId = url.pathname.split("/").at(-2);
        return json([message(window.sinceMs + 1, url.pathname, BigInt(channelId ?? "0"))]);
      }
      return undefined;
    });
    const result = await createDiscordSource(context).collect(config, window, roster);
    expect(archivePages).toBe(2);
    expect(
      result.messages.map(({ channelId, parentChannelId, channelName }) => ({
        channelId,
        parentChannelId,
        channelName,
      })),
    ).toEqual([
      { channelId: "20", parentChannelId: "20", channelName: "engineering" },
      { channelId: "21", parentChannelId: "20", channelName: "engineering/review" },
      { channelId: "22", parentChannelId: "20", channelName: "engineering/design" },
    ]);
    expect(context.requests.filter((url) => url.pathname.endsWith("/messages"))).toHaveLength(3);
    expect(context.logs).toEqual([
      "team-reports: Discord channels/threads listed: 1 channels, 2 threads",
      "team-reports: Discord messages done: 1 channels, 2 threads, 3 messages",
    ]);
  });

  it.each([0.25, 3_000_000])(
    "waits %s seconds for Discord retry_after before retrying",
    async (seconds) => {
      vi.useFakeTimers();
      let attempts = 0;
      const context = runtime((url) => {
        if (url.pathname.endsWith("/messages")) {
          attempts += 1;
          return attempts === 1
            ? json({ retry_after: seconds }, 429)
            : json([message(window.sinceMs + 1)]);
        }
        return undefined;
      });
      const pending = createDiscordSource(context).collect(config, window, roster);
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(attempts).toBe(2);
      expect(result.messages).toHaveLength(1);
      expect(result.status.stats.apiCalls).toBe(context.requests.length);
    },
  );

  it("warns on missing channel access and collects accessible sibling channels without exposing tokens", async () => {
    const context = runtime((url) => {
      if (url.pathname.endsWith("/guilds/10/channels")) {
        return json([
          { id: "20", name: "restricted" },
          { id: "21", name: "general" },
        ]);
      }
      if (url.pathname.endsWith("/channels/20/messages")) {
        return json({ message: `Missing access ${config.token}` }, 403);
      }
      if (url.pathname.endsWith("/channels/21/messages")) {
        return json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const result = await createDiscordSource(context).collect(
      {
        ...config,
        channels: [
          { id: "20", excerpts: false },
          { id: "21", excerpts: false },
        ],
      },
      window,
      roster,
    );
    expect(result.status.ok).toBe(true);
    expect(result.status.stale).toBe(true);
    expect(result.status.warnings).toEqual([expect.stringMatching(/20.*403/)]);
    expect(result.messages.map((entry) => entry.channelId)).toEqual(["21"]);
    expect(JSON.stringify({ status: result.status, logs: context.logs })).not.toContain(
      config.token,
    );
  });

  it("aborts rate-limit waits without requesting another page", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const context = runtime(
      (url) => (url.pathname.endsWith("/messages") ? json({ retry_after: 60 }, 429) : undefined),
      controller.signal,
    );
    const pending = createDiscordSource(context).collect(config, window, roster);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    const requestsBeforeAbort = context.requests.length;
    controller.abort(new Error(config.token));
    await rejected;
    await vi.advanceTimersByTimeAsync(60000);
    expect(context.requests).toHaveLength(requestsBeforeAbort);
    expect(context.logs.join(" ")).not.toContain(config.token);
  });

  it("stops paging immediately when the run is aborted during a response", async () => {
    const controller = new AbortController();
    const context = runtime((url) => {
      if (url.pathname.endsWith("/messages")) {
        controller.abort();
        return json(Array.from({ length: 100 }, (_, index) => message(window.sinceMs + index + 1)));
      }
      return undefined;
    }, controller.signal);
    await expect(
      createDiscordSource(context).collect(config, window, roster),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(context.requests.filter((url) => url.pathname.endsWith("/messages"))).toHaveLength(1);
  });
});
