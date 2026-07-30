// Slack tests cover monitor.media plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSlackThreadStarterCacheForTest, resolveSlackThreadStarter } from "./thread.js";

type ThreadStarterClient = Parameters<typeof resolveSlackThreadStarter>[0]["client"];

function createThreadStarterRepliesClient(
  response: { messages?: Array<{ text?: string; user?: string; ts?: string }> } = {
    messages: [{ text: "root message", user: "U1", ts: "1000.1" }],
  },
): { replies: ReturnType<typeof vi.fn>; client: ThreadStarterClient } {
  const replies = vi.fn(async () => response);
  const client = {
    conversations: { replies },
  } as unknown as ThreadStarterClient;
  return { replies, client };
}

describe("resolveSlackThreadStarter cache", () => {
  afterEach(() => {
    resetSlackThreadStarterCacheForTest();
    vi.useRealTimers();
  });

  it("returns cached thread starter without refetching within ttl", async () => {
    const { replies, client } = createThreadStarterRepliesClient();

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(first).toEqual(second);
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("isolates the same channel and thread across enterprise workspaces", async () => {
    const teamOne = createThreadStarterRepliesClient({
      messages: [{ text: "team one root", user: "U1", ts: "1000.1" }],
    });
    const teamTwo = createThreadStarterRepliesClient({
      messages: [{ text: "team two root", user: "U2", ts: "1000.1" }],
    });

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client: teamOne.client,
      workspaceScope: { accountId: "enterprise", teamId: "T1" },
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client: teamTwo.client,
      workspaceScope: { accountId: "enterprise", teamId: "T2" },
    });
    const cachedFirst = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client: teamOne.client,
      workspaceScope: { accountId: "enterprise", teamId: "T1" },
    });

    expect(first?.text).toBe("team one root");
    expect(second?.text).toBe("team two root");
    expect(cachedFirst?.text).toBe("team one root");
    expect(teamOne.replies).toHaveBeenCalledTimes(1);
    expect(teamTwo.replies).toHaveBeenCalledTimes(1);
  });

  it("expires stale cache entries and refetches after ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { replies, client } = createThreadStarterRepliesClient();

    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    vi.setSystemTime(new Date("2026-01-01T07:00:00.000Z"));
    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("drops cached thread starters when the current clock is not a valid date timestamp", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { replies, client } = createThreadStarterRepliesClient();

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });
    nowSpy.mockReturnValue(Number.NaN);
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(first).toEqual(second);
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not cache thread starters when the expiry timestamp would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const { replies, client } = createThreadStarterRepliesClient();

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(first).toEqual(second);
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not cache empty starter text", async () => {
    const { replies, client } = createThreadStarterRepliesClient({
      messages: [{ text: "   ", user: "U1", ts: "1000.1" }],
    });

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entries once cache exceeds bounded size", async () => {
    const { replies, client } = createThreadStarterRepliesClient();

    for (let i = 0; i <= 2000; i += 1) {
      await resolveSlackThreadStarter({
        channelId: "C1",
        threadTs: `1000.${i}`,
        client,
      });
    }
    const callsAfterFill = replies.mock.calls.length;

    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.0",
      client,
    });

    expect(replies.mock.calls.length).toBe(callsAfterFill + 1);
  });
});
