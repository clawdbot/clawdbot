import { beforeEach, describe, expect, it } from "vitest";
import {
  addMattermostReaction,
  removeMattermostReaction,
  resetMattermostReactionBotUserCacheForTests,
} from "./reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  requestUrl,
} from "./reactions.test-helpers.js";

describe("mattermost reactions", () => {
  beforeEach(() => {
    resetMattermostReactionBotUserCacheForTests();
  });

  async function addReactionWithFetch(fetchMock: typeof fetch) {
    return addMattermostReaction({
      cfg: createMattermostTestConfig(),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock,
    });
  }

  async function removeReactionWithFetch(fetchMock: typeof fetch) {
    return removeMattermostReaction({
      cfg: createMattermostTestConfig(),
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

    const cfg = createMattermostTestConfig();
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
});
