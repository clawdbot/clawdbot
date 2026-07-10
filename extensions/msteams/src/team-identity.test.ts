// Msteams tests cover canonical team identity resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _teamGroupIdCacheForTest, resolveTeamGroupId } from "./team-identity.js";

describe("resolveTeamGroupId", () => {
  const getTeamDetails = vi.fn<(teamId: string) => Promise<{ aadGroupId?: string }>>();

  beforeEach(() => {
    getTeamDetails.mockReset();
    getTeamDetails.mockResolvedValue({ aadGroupId: "group-guid" });
    _teamGroupIdCacheForTest.clear();
  });

  it("uses and caches the activity AAD group ID without a Teams API lookup", async () => {
    const result = await resolveTeamGroupId({
      conversationTeamId: "team-123",
      aadGroupId: " group-guid-1 ",
      getTeamDetails,
    });
    const cached = await resolveTeamGroupId({
      conversationTeamId: "team-123",
      getTeamDetails,
    });

    expect(result).toBe("group-guid-1");
    expect(cached).toBe("group-guid-1");
    expect(getTeamDetails).not.toHaveBeenCalled();
  });

  it("resolves a missing AAD group ID through the Teams API", async () => {
    getTeamDetails.mockResolvedValueOnce({ aadGroupId: " group-guid-2 " });

    const result = await resolveTeamGroupId({
      conversationTeamId: "19:team@thread.skype",
      getTeamDetails,
    });

    expect(result).toBe("group-guid-2");
    expect(getTeamDetails).toHaveBeenCalledWith("19:team@thread.skype");
  });

  it("returns cached value without calling the Teams API again", async () => {
    const params = { conversationTeamId: "team-456", getTeamDetails };

    await resolveTeamGroupId(params);
    await resolveTeamGroupId(params);

    expect(getTeamDetails).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled Teams API identity lookup", async () => {
    vi.useFakeTimers();
    try {
      getTeamDetails.mockImplementationOnce(() => new Promise(() => {}));
      const result = resolveTeamGroupId({
        conversationTeamId: "team-stalled",
        getTeamDetails,
        deadline: {
          label: "MS Teams inbound preprocessing",
          timeoutMs: 50,
          deadlineAtMs: Date.now() + 50,
        },
      });
      const assertion = expect(result).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns undefined instead of sending a raw Bot Framework team ID to Graph", async () => {
    getTeamDetails.mockResolvedValueOnce({});

    await expect(
      resolveTeamGroupId({
        conversationTeamId: "19:team@thread.skype",
        getTeamDetails,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when no per-activity Teams resolver is available", async () => {
    await expect(
      resolveTeamGroupId({ conversationTeamId: "19:team@thread.skype" }),
    ).resolves.toBeUndefined();
  });

  it("caps cache at 500 entries and evicts the oldest team", async () => {
    for (let i = 0; i < 500; i++) {
      await resolveTeamGroupId({ conversationTeamId: `team-${i}`, getTeamDetails });
    }

    await resolveTeamGroupId({ conversationTeamId: "team-500", getTeamDetails });

    expect(_teamGroupIdCacheForTest.size).toBe(500);
    expect(_teamGroupIdCacheForTest.has("team-0")).toBe(false);
    expect(_teamGroupIdCacheForTest.has("team-500")).toBe(true);
  });
});
