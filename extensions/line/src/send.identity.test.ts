// Line tests cover how inbound identity lookups pick their LINE endpoint.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getProfileMock,
  getGroupMemberProfileMock,
  getRoomMemberProfileMock,
  getGroupSummaryMock,
  MessagingApiClientMock,
  requireRuntimeConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  logVerboseMock,
} = vi.hoisted(() => {
  const getProfileMockLocal = vi.fn();
  const getGroupMemberProfileMockLocal = vi.fn();
  const getRoomMemberProfileMockLocal = vi.fn();
  const getGroupSummaryMockLocal = vi.fn();
  return {
    getProfileMock: getProfileMockLocal,
    getGroupMemberProfileMock: getGroupMemberProfileMockLocal,
    getRoomMemberProfileMock: getRoomMemberProfileMockLocal,
    getGroupSummaryMock: getGroupSummaryMockLocal,
    MessagingApiClientMock: vi.fn(function () {
      return {
        getProfile: getProfileMockLocal,
        getGroupMemberProfile: getGroupMemberProfileMockLocal,
        getRoomMemberProfile: getRoomMemberProfileMockLocal,
        getGroupSummary: getGroupSummaryMockLocal,
      };
    }),
    requireRuntimeConfigMock: vi.fn((cfg: unknown) => cfg ?? {}),
    resolveLineAccountMock: vi.fn(() => ({ accountId: "default" })),
    resolveLineChannelAccessTokenMock: vi.fn(() => "line-token"),
    logVerboseMock: vi.fn(),
  };
});

vi.mock("@line/bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@line/bot-sdk")>();
  return {
    ...actual,
    messagingApi: { ...actual.messagingApi, MessagingApiClient: MessagingApiClientMock },
  };
});

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: requireRuntimeConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveLineAccount: resolveLineAccountMock,
}));

vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return { ...actual, logVerbose: logVerboseMock };
});

const LINE_TEST_CFG = { channels: { line: { accounts: { default: {} } } } };

describe("LINE identity lookups", () => {
  let sendModule: typeof import("./send.js");

  beforeEach(async () => {
    sendModule = await import("./send.js");
    getProfileMock.mockReset();
    getGroupMemberProfileMock.mockReset();
    getRoomMemberProfileMock.mockReset();
    getGroupSummaryMock.mockReset();
  });

  // A member who has not added the bot as a friend is invisible to the plain
  // profile endpoint, so the conversation the message came from decides which
  // endpoint can answer at all.
  const memberProfileCases = [
    {
      name: "asks the group endpoint for a group member",
      userId: "Ugroupmember",
      scope: { groupId: "Cgroup1" },
      endpoint: () => getGroupMemberProfileMock,
      args: ["Cgroup1", "Ugroupmember"],
    },
    {
      name: "asks the room endpoint for a room member",
      userId: "Uroommember",
      scope: { roomId: "Rroom1" },
      endpoint: () => getRoomMemberProfileMock,
      args: ["Rroom1", "Uroommember"],
    },
    {
      name: "asks the plain profile endpoint in a direct message",
      userId: "Udirect",
      scope: {},
      endpoint: () => getProfileMock,
      args: ["Udirect"],
    },
  ];

  it.each(memberProfileCases)("$name", async ({ userId, scope, endpoint, args }) => {
    const target = endpoint();
    target.mockResolvedValueOnce({ displayName: "Sora", userId });

    const profile = await sendModule.getUserProfile(userId, { cfg: LINE_TEST_CFG, ...scope });

    expect(profile?.displayName).toBe("Sora");
    expect(target).toHaveBeenCalledWith(...args);
  });

  it("degrades to no profile when LINE cannot answer", async () => {
    getGroupMemberProfileMock.mockRejectedValue(new Error("404 not found"));

    await expect(
      sendModule.getUserProfile("Umissing", { cfg: LINE_TEST_CFG, groupId: "Cgroup2" }),
    ).resolves.toBeNull();
    await expect(
      sendModule.getUserProfile("Umissing", { cfg: LINE_TEST_CFG, groupId: "Cgroup2" }),
    ).resolves.toBeNull();

    expect(getGroupMemberProfileMock).toHaveBeenCalledTimes(1);
  });

  it("keeps profile cache entries scoped to their conversation endpoint", async () => {
    getGroupMemberProfileMock.mockResolvedValueOnce({ displayName: "Group Sora" });
    getRoomMemberProfileMock.mockResolvedValueOnce({ displayName: "Room Sora" });

    await expect(
      sendModule.getUserProfile("Ushared", { cfg: LINE_TEST_CFG, groupId: "Cshared" }),
    ).resolves.toMatchObject({ displayName: "Group Sora" });
    await expect(
      sendModule.getUserProfile("Ushared", { cfg: LINE_TEST_CFG, roomId: "Rshared" }),
    ).resolves.toMatchObject({ displayName: "Room Sora" });

    expect(getGroupMemberProfileMock).toHaveBeenCalledTimes(1);
    expect(getRoomMemberProfileMock).toHaveBeenCalledTimes(1);
  });

  it("resolves a group name once and serves the rest from cache", async () => {
    getGroupSummaryMock.mockResolvedValue({ groupId: "Cnamed", groupName: "Release Squad" });

    await expect(sendModule.getLineGroupName("Cnamed", { cfg: LINE_TEST_CFG })).resolves.toBe(
      "Release Squad",
    );
    await expect(sendModule.getLineGroupName("Cnamed", { cfg: LINE_TEST_CFG })).resolves.toBe(
      "Release Squad",
    );

    expect(getGroupSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent group-name cache misses", async () => {
    let resolveSummary: (summary: { groupId: string; groupName: string }) => void = () => {};
    getGroupSummaryMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSummary = resolve;
      }),
    );

    const first = sendModule.getLineGroupName("Cconcurrent", { cfg: LINE_TEST_CFG });
    const second = sendModule.getLineGroupName("Cconcurrent", { cfg: LINE_TEST_CFG });
    expect(getGroupSummaryMock).toHaveBeenCalledTimes(1);

    resolveSummary({ groupId: "Cconcurrent", groupName: "Release Squad" });
    await expect(Promise.all([first, second])).resolves.toEqual(["Release Squad", "Release Squad"]);
  });

  it("degrades to no group name when the summary call fails", async () => {
    getGroupSummaryMock.mockRejectedValue(new Error("403 forbidden"));

    await expect(
      sendModule.getLineGroupName("Cforbidden", { cfg: LINE_TEST_CFG }),
    ).resolves.toBeUndefined();
    await expect(
      sendModule.getLineGroupName("Cforbidden", { cfg: LINE_TEST_CFG }),
    ).resolves.toBeUndefined();

    expect(getGroupSummaryMock).toHaveBeenCalledTimes(1);
  });
});
