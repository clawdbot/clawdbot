// Msteams tests cover canonical team identity resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTeamGroupId } from "./team-identity.js";

describe("resolveTeamGroupId", () => {
  const getTeamDetails = vi.fn<(teamId: string) => Promise<{ aadGroupId?: string }>>();
  let testSequence = 0;
  let teamIdPrefix = "";
  const teamId = (value: string) => `${teamIdPrefix}:${value}`;

  beforeEach(() => {
    teamIdPrefix = `team-identity-test-${++testSequence}`;
    getTeamDetails.mockReset();
    getTeamDetails.mockResolvedValue({ aadGroupId: "group-guid" });
  });

  it("uses and caches the activity AAD group ID without a Teams API lookup", async () => {
    const conversationTeamId = teamId("activity-aad");
    const result = await resolveTeamGroupId({
      conversationTeamId,
      aadGroupId: " group-guid-1 ",
      getTeamDetails,
    });
    const cached = await resolveTeamGroupId({
      conversationTeamId,
      getTeamDetails,
    });

    expect(result).toBe("group-guid-1");
    expect(cached).toBe("group-guid-1");
    expect(getTeamDetails).not.toHaveBeenCalled();
  });

  it("resolves a missing AAD group ID through the Teams API", async () => {
    const conversationTeamId = teamId("api-lookup");
    getTeamDetails.mockResolvedValueOnce({ aadGroupId: " group-guid-2 " });

    const result = await resolveTeamGroupId({
      conversationTeamId,
      getTeamDetails,
    });

    expect(result).toBe("group-guid-2");
    expect(getTeamDetails).toHaveBeenCalledWith(conversationTeamId);
  });

  it("returns cached value without calling the Teams API again", async () => {
    const params = { conversationTeamId: teamId("cached"), getTeamDetails };

    await resolveTeamGroupId(params);
    await resolveTeamGroupId(params);

    expect(getTeamDetails).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled Teams API identity lookup", async () => {
    vi.useFakeTimers();
    try {
      getTeamDetails.mockImplementationOnce(() => new Promise(() => {}));
      const result = resolveTeamGroupId({
        conversationTeamId: teamId("stalled"),
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
        conversationTeamId: teamId("missing-aad"),
        getTeamDetails,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when no per-activity Teams resolver is available", async () => {
    await expect(
      resolveTeamGroupId({ conversationTeamId: teamId("missing-resolver") }),
    ).resolves.toBeUndefined();
  });

  it("caps cache at 500 entries and evicts the oldest team", async () => {
    for (let i = 0; i < 500; i++) {
      await resolveTeamGroupId({ conversationTeamId: teamId(`eviction-${i}`), getTeamDetails });
    }

    await resolveTeamGroupId({ conversationTeamId: teamId("eviction-500"), getTeamDetails });

    expect(getTeamDetails).toHaveBeenCalledTimes(501);
    await resolveTeamGroupId({ conversationTeamId: teamId("eviction-0"), getTeamDetails });
    expect(getTeamDetails).toHaveBeenCalledTimes(502);
    await resolveTeamGroupId({ conversationTeamId: teamId("eviction-500"), getTeamDetails });
    expect(getTeamDetails).toHaveBeenCalledTimes(502);
  });
});
