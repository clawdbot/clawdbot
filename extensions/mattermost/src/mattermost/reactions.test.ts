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
      fetchImpl: fetchMock,
    });
  }

  async function removeReactionWithFetch(fetchMock: typeof fetch) {
    return removeMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock,
    });
  }

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
      fetchImpl: fetchMock,
    });
    const removeResult = await removeMattermostReaction({
      cfg,
      postId: "POST1",
      emojiName: "thumbsup",
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
        fetchImpl: firstFetch,
      }),
    ).resolves.toEqual({ ok: true });

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    await expect(
      addMattermostReaction({
        cfg,
        postId: "POST2",
        emojiName: "thumbsup",
        fetchImpl: secondFetch,
      }),
    ).resolves.toEqual({ ok: true });

    vi.mocked(Date.now).mockReturnValue(1_000);
    await expect(
      addMattermostReaction({
        cfg,
        postId: "POST3",
        emojiName: "thumbsup",
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
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      removeMattermostReaction({
        cfg,
        postId: "POST1",
        emojiName: "thumbsup",
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ ok: true });

    const usersMeCalls = fetchMock.mock.calls.filter((call) =>
      requestUrl(call[0]).endsWith("/api/v4/users/me"),
    );
    expect(usersMeCalls).toHaveLength(2);
  });
});
