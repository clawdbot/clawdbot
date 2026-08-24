// Mattermost tests cover reactions plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMattermostReaction, removeMattermostReaction } from "./reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  requestUrl,
} from "./reactions.test-helpers.js";

describe("mattermost reactions", () => {
  let cacheKeySequence = 0;
  let cacheKey = "";

  beforeEach(() => {
    cacheKey = String(++cacheKeySequence);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function addReactionWithFetch(fetchMock: typeof fetch) {
    return addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
      fetchImpl: fetchMock,
    });
  }

  async function removeReactionWithFetch(fetchMock: typeof fetch) {
    return removeMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
      fetchImpl: fetchMock,
    });
  }

  it("binds delegated reactions to the authorized channel before mutation", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "CHANNEL1",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      expect.stringMatching(/\/api\/v4\/posts\/POST1$/),
      expect.stringMatching(/\/api\/v4\/users\/me$/),
      expect.stringMatching(/\/api\/v4\/reactions$/),
    ]);
  });

  it("rejects crossed delegated channel posts before bot lookup or mutation", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "CHANNEL2",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("belongs to a different conversation"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("binds delegated reaction removal to the authorized channel", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "remove",
      postId: "POST1",
      postChannelId: "CHANNEL1",
      emojiName: "thumbsup",
    });

    const result = await removeMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "group:CHANNEL1",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true });
    expect(
      fetchMock.mock.calls.some((call) =>
        requestUrl(call[0]).endsWith("/api/v4/users/BOT123/posts/POST1/reactions/thumbsup"),
      ),
    ).toBe(true);
  });

  it.each([undefined, "delegated" as const])(
    "fails closed for %s origin without a canonical target",
    async (conversationReadOrigin) => {
      const fetchMock = createMattermostReactionFetchMock({
        mode: "add",
        postId: "POST1",
        postChannelId: "CHANNEL1",
        emojiName: "thumbsup",
      });

      const result = await addMattermostReaction({
        cfg: createMattermostTestConfig(cacheKey),
        postId: "POST1",
        emojiName: "thumbsup",
        conversationReadOrigin,
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining("require a canonical authorized conversation target"),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("binds delegated direct-message reactions to the bot and selected peer", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__PEER123",
      userId: "BOT123",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "user:PEER123",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects delegated direct-message posts owned by another peer", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__OTHER123",
      userId: "BOT123",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "user:PEER123",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("belongs to a different direct conversation"),
    });
    expect(
      fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith("/api/v4/reactions")),
    ).toBe(false);
  });

  it("binds delegated self-DM reactions without collapsing duplicate participant ids", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__BOT123",
      userId: "BOT123",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "user:BOT123",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects another peer's DM when the delegated target is the bot itself", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__OTHER123",
      userId: "BOT123",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "user:BOT123",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("belongs to a different direct conversation"),
    });
    expect(
      fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith("/api/v4/reactions")),
    ).toBe(false);
  });

  it("fails closed when delegated post metadata omits the provider channel", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: null,
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("missing its conversation binding"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the selected account for delegated binding and mutation", async () => {
    const defaultAccount = createMattermostTestConfig("default-account").channels?.mattermost;
    const workAccount = createMattermostTestConfig("work-account").channels?.mattermost;
    if (!defaultAccount || !workAccount) {
      throw new Error("expected Mattermost account fixtures");
    }
    const innerFetch = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "CHANNEL1",
      emojiName: "thumbsup",
    });
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(requestUrl(url)).toContain("https://work-account.chat.example.com/api/v4/");
      return await innerFetch(url, init);
    });

    const result = await addMattermostReaction({
      cfg: {
        channels: {
          mattermost: {
            enabled: true,
            accounts: {
              default: defaultAccount,
              work: workAccount,
            },
          },
        },
      },
      accountId: "work",
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves direct-operator crossed-post reactions without a provider metadata read", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:DIFFERENT",
      conversationReadOrigin: "direct-operator",
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      expect.stringMatching(/\/api\/v4\/users\/me$/),
      expect.stringMatching(/\/api\/v4\/reactions$/),
    ]);
  });

  it("adds reactions by calling /users/me then POST /reactions", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    const result = await addReactionWithFetch(fetchMock);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns a Result error when add reaction API call fails", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
      status: 500,
      body: { id: "err", message: "boom" },
    });

    const result = await addReactionWithFetch(fetchMock);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Mattermost add reaction failed");
    }
  });

  it("removes reactions by calling /users/me then DELETE /users/:id/posts/:postId/reactions/:emoji", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "remove",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    const result = await removeReactionWithFetch(fetchMock);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("caches the bot user id across reaction mutations", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "both",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    const cfg = createMattermostTestConfig(cacheKey);
    const addResult = await addMattermostReaction({
      cfg,
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
      fetchImpl: fetchMock,
    });
    const removeResult = await removeMattermostReaction({
      cfg,
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
      fetchImpl: fetchMock,
    });

    const usersMeCalls = fetchMock.mock.calls.filter((call) =>
      requestUrl(call[0]).endsWith("/api/v4/users/me"),
    );
    expect(addResult).toEqual({ ok: true });
    expect(removeResult).toEqual({ ok: true });
    expect(usersMeCalls).toHaveLength(1);
  });

  it("does not reuse cached bot user ids while the process clock is invalid", async () => {
    const cfg = createMattermostTestConfig(cacheKey);
    const firstFetch = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
      userId: "BOT_OLD",
    });
    const secondFetch = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST2",
      emojiName: "thumbsup",
      userId: "BOT_FRESH",
    });
    const thirdFetch = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST3",
      emojiName: "thumbsup",
      userId: "BOT_RECOVERED",
    });

    await expect(
      addMattermostReaction({
        cfg,
        postId: "POST1",
        emojiName: "thumbsup",
        conversationReadOrigin: "direct-operator",
        fetchImpl: firstFetch,
      }),
    ).resolves.toEqual({ ok: true });

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    await expect(
      addMattermostReaction({
        cfg,
        postId: "POST2",
        emojiName: "thumbsup",
        conversationReadOrigin: "direct-operator",
        fetchImpl: secondFetch,
      }),
    ).resolves.toEqual({ ok: true });

    vi.mocked(Date.now).mockReturnValue(1_000);
    await expect(
      addMattermostReaction({
        cfg,
        postId: "POST3",
        emojiName: "thumbsup",
        conversationReadOrigin: "direct-operator",
        fetchImpl: thirdFetch,
      }),
    ).resolves.toEqual({ ok: true });

    const usersMeCalls = [
      ...firstFetch.mock.calls,
      ...secondFetch.mock.calls,
      ...thirdFetch.mock.calls,
    ].filter((call) => requestUrl(call[0]).endsWith("/api/v4/users/me"));
    expect(usersMeCalls).toHaveLength(3);
  });

  it("does not cache bot user ids when cache expiry would exceed the Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const cfg = createMattermostTestConfig(cacheKey);
    const fetchMock = createMattermostReactionFetchMock({
      mode: "both",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    await expect(
      addMattermostReaction({
        cfg,
        postId: "POST1",
        emojiName: "thumbsup",
        conversationReadOrigin: "direct-operator",
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      removeMattermostReaction({
        cfg,
        postId: "POST1",
        emojiName: "thumbsup",
        conversationReadOrigin: "direct-operator",
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ ok: true });

    const usersMeCalls = fetchMock.mock.calls.filter((call) =>
      requestUrl(call[0]).endsWith("/api/v4/users/me"),
    );
    expect(usersMeCalls).toHaveLength(2);
  });
});
