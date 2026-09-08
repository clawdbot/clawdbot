import { afterEach, describe, expect, it, vi } from "vitest";
import { config, json, message, roster, runtime, thread, window } from "./discord.fixtures.js";
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

  it.each([
    ["public", 11],
    ["private", 12],
  ])(
    "rolls active and %s archived threads into configured parents and bounds archive paging",
    async (archiveKind, type) => {
      const archiveTimes = [window.untilMs + 1000, window.sinceMs + 1000, window.sinceMs - 1];
      let archivePages = 0;
      const context = runtime((url) => {
        if (url.pathname.endsWith("/threads/active")) {
          return json({
            threads: [
              { id: "22", parent_id: "20", name: "design", type },
              { id: "90", parent_id: "99", name: "outside" },
            ],
          });
        }
        if (url.pathname.endsWith(`/channels/20/threads/archived/${archiveKind}`)) {
          expect(url.searchParams.get("limit")).toBe("100");
          archivePages += 1;
          if (archivePages === 1) {
            return json({
              threads: [
                {
                  id: "22",
                  parent_id: "20",
                  name: "design",
                  type,
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
                type,
                thread_metadata: {
                  archive_timestamp: new Date(archiveTimes[1] ?? 0).toISOString(),
                },
              },
              {
                id: "23",
                parent_id: "20",
                name: "old",
                type,
                thread_metadata: {
                  archive_timestamp: new Date(archiveTimes[2] ?? 0).toISOString(),
                },
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
    },
  );

  it("preserves private thread messages after the thread archives", async () => {
    const privateThread = thread(message(window.sinceMs - 1000).id, window.sinceMs + 1000);
    let archived = false;
    const context = runtime((url) => {
      if (url.pathname.endsWith("/threads/active")) {
        return json({ threads: archived ? [] : [privateThread] });
      }
      if (url.pathname.endsWith("/channels/20/threads/archived/private")) {
        return json({ threads: archived ? [privateThread] : [], has_more: false });
      }
      if (url.pathname.endsWith(`/channels/${privateThread.id}/messages`)) {
        expect(url.searchParams.get("after")).toBe("175928843960320000");
        return json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const source = createDiscordSource(context);
    const activeResult = await source.collect(config, window, roster);
    archived = true;
    const archivedResult = await source.collect(config, window, roster);
    expect(activeResult.messages).toHaveLength(1);
    expect(archivedResult.messages).toEqual(activeResult.messages);
    expect(archivedResult.status.warnings).toEqual([]);
    expect(archivedResult.status.stale).not.toBe(true);
  });

  it("falls back to joined private archives and pages by thread id past old archive timestamps", async () => {
    const newerThread = thread(message(window.sinceMs - 1000).id, window.sinceMs - 1);
    const olderThread = thread(message(window.sinceMs - 2000).id, window.sinceMs + 1000);
    let joinedPages = 0;
    const context = runtime((url) => {
      if (url.pathname.endsWith("/channels/20/threads/archived/private")) {
        return json({}, 403);
      }
      if (url.pathname.endsWith("/users/@me/threads/archived/private")) {
        joinedPages += 1;
        expect(url.searchParams.get("limit")).toBe("100");
        expect(url.searchParams.get("before")).toBe(joinedPages === 1 ? null : newerThread.id);
        return json({
          threads: [joinedPages === 1 ? newerThread : olderThread],
          has_more: joinedPages === 1,
        });
      }
      if (url.pathname.endsWith(`/channels/${olderThread.id}/messages`)) {
        return json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const result = await createDiscordSource(context).collect(config, window, roster);
    expect(result.messages.map((entry) => entry.channelId)).toEqual([olderThread.id]);
    expect(joinedPages).toBe(2);
    expect(result.status.warnings).toEqual([]);
    expect(result.status.stale).not.toBe(true);
    expect(result.status.stats.privateArchivesSkipped).toBe(0);
  });

  it("counts inaccessible private archives without warnings or stale status when both endpoints return 403", async () => {
    const context = runtime((url) => {
      if (url.pathname.endsWith("/threads/archived/private")) {
        return json({}, 403);
      }
      if (url.pathname.endsWith("/channels/20/messages")) {
        return json([message(window.sinceMs + 1)]);
      }
      return undefined;
    });
    const result = await createDiscordSource(context).collect(config, window, roster);
    expect(result.messages).toHaveLength(1);
    expect(result.status.ok).toBe(true);
    expect(result.status.stale).not.toBe(true);
    expect(result.status.warnings).toEqual([]);
    expect(result.status.stats.privateArchivesSkipped).toBe(1);
    expect(
      context.requests.filter((url) => url.pathname.endsWith("/threads/archived/private")),
    ).toHaveLength(2);
  });

  it.each(["primary", "joined"])(
    "warns on non-403 failures from %s private archives",
    async (endpoint) => {
      const context = runtime((url) => {
        if (url.pathname.endsWith("/channels/20/threads/archived/private")) {
          return json({}, endpoint === "primary" ? 404 : 403);
        }
        if (url.pathname.endsWith("/users/@me/threads/archived/private")) {
          return json({}, 404);
        }
        return undefined;
      });
      const result = await createDiscordSource(context).collect(config, window, roster);
      expect(result.status.warnings).toEqual([expect.stringMatching(/20.*404/)]);
      expect(result.status.stale).toBe(true);
      expect(result.status.stats.privateArchivesSkipped).toBe(0);
    },
  );

  it.each([15, 16])(
    "collects archived posts from type %s channels without requesting parent messages",
    async (type) => {
      const context = runtime((url) => {
        if (url.pathname.endsWith("/guilds/10/channels")) {
          return json([{ id: "20", name: "posts", type }]);
        }
        if (url.pathname.endsWith("/threads/archived/public")) {
          return json({ threads: [thread("21", window.sinceMs + 1000, 11)], has_more: false });
        }
        if (url.pathname.endsWith("/channels/21/messages")) {
          return json([message(window.sinceMs + 1)]);
        }
        return undefined;
      });
      const result = await createDiscordSource(context).collect(config, window, roster);
      expect(result.messages.map((entry) => entry.channelName)).toEqual(["posts/discussion"]);
      expect(context.requests.some((url) => url.pathname.endsWith("/channels/20/messages"))).toBe(
        false,
      );
      expect(result.status.warnings).toEqual([]);
    },
  );

  it("collects active announcement thread messages beyond 100 pages regardless of thread creation time", async () => {
    const activeThread = thread(message(window.sinceMs - 1000).id, window.sinceMs - 1000, 10);
    let pages = 0;
    const context = runtime((url) => {
      if (url.pathname.endsWith("/threads/active")) {
        return json({ threads: [activeThread] });
      }
      if (url.pathname.endsWith(`/channels/${activeThread.id}/messages`)) {
        const after = BigInt(url.searchParams.get("after") ?? "0");
        pages += 1;
        return json(
          Array.from({ length: pages <= 100 ? 100 : 1 }, (_, index) => ({
            ...message(window.sinceMs + 1),
            id: (after + BigInt(index + 1)).toString(),
          })).toReversed(),
        );
      }
      return undefined;
    });
    const result = await createDiscordSource(context).collect(config, window, roster);
    expect(pages).toBe(101);
    expect(result.messages).toHaveLength(10001);
    expect(
      result.messages.every(
        (entry) => entry.channelId === activeThread.id && entry.atMs === window.sinceMs,
      ),
    ).toBe(true);
    expect(result.status.warnings).toEqual([]);
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
