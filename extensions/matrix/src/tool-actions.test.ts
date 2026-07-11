// Matrix tests cover tool actions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMatrixAction } from "./tool-actions.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  voteMatrixPoll: vi.fn(),
  reactMatrixMessage: vi.fn(),
  editMatrixMessage: vi.fn(),
  deleteMatrixMessage: vi.fn(),
  listMatrixReactions: vi.fn(),
  removeMatrixReactions: vi.fn(),
  sendMatrixMessage: vi.fn(),
  pinMatrixMessage: vi.fn(),
  unpinMatrixMessage: vi.fn(),
  listMatrixPins: vi.fn(),
  getMatrixMemberInfo: vi.fn(),
  getMatrixRoomInfo: vi.fn(),
  applyMatrixProfileUpdate: vi.fn(),
  matrixClient: { id: "matrix-client" },
  withAuthorizedMatrixReadTarget: vi.fn(),
}));

vi.mock("./matrix/read-policy.js", () => ({
  withAuthorizedMatrixReadTarget: mocks.withAuthorizedMatrixReadTarget,
}));

vi.mock("./matrix/actions.js", () => {
  return {
    deleteMatrixMessage: mocks.deleteMatrixMessage,
    editMatrixMessage: mocks.editMatrixMessage,
    getMatrixMemberInfo: mocks.getMatrixMemberInfo,
    getMatrixRoomInfo: mocks.getMatrixRoomInfo,
    listMatrixReactions: mocks.listMatrixReactions,
    pinMatrixMessage: mocks.pinMatrixMessage,
    unpinMatrixMessage: mocks.unpinMatrixMessage,
    listMatrixPins: mocks.listMatrixPins,
    removeMatrixReactions: mocks.removeMatrixReactions,
    sendMatrixMessage: mocks.sendMatrixMessage,
    voteMatrixPoll: mocks.voteMatrixPoll,
  };
});

vi.mock("./matrix/send.js", () => {
  return {
    reactMatrixMessage: mocks.reactMatrixMessage,
  };
});

vi.mock("./profile-update.js", () => ({
  applyMatrixProfileUpdate: (...args: unknown[]) => mocks.applyMatrixProfileUpdate(...args),
}));

describe("handleMatrixAction pollVote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAuthorizedMatrixReadTarget.mockImplementation(
      async (params: {
        roomId: string;
        run: (target: { client: unknown; roomId: string }) => Promise<unknown>;
      }) =>
        await params.run({
          client: mocks.matrixClient,
          roomId: params.roomId.replace(/^room:/, ""),
        }),
    );
    mocks.voteMatrixPoll.mockResolvedValue({
      eventId: "evt-poll-vote",
      roomId: "!room:example",
      pollId: "$poll",
      answerIds: ["a1", "a2"],
      labels: ["Pizza", "Sushi"],
      maxSelections: 2,
    });
    mocks.listMatrixReactions.mockResolvedValue([{ key: "👍", count: 1, users: ["@u:example"] }]);
    mocks.listMatrixPins.mockResolvedValue({ pinned: ["$pin"], events: [] });
    mocks.pinMatrixMessage.mockResolvedValue({ pinned: ["$existing", "$pin"] });
    mocks.unpinMatrixMessage.mockResolvedValue({ pinned: ["$existing"] });
    mocks.removeMatrixReactions.mockResolvedValue({ removed: 1 });
    mocks.sendMatrixMessage.mockResolvedValue({
      messageId: "$sent",
      roomId: "!room:example",
    });
    mocks.editMatrixMessage.mockResolvedValue({ eventId: "$edited" });
    mocks.getMatrixMemberInfo.mockResolvedValue({ userId: "@u:example" });
    mocks.getMatrixRoomInfo.mockResolvedValue({ roomId: "!room:example" });
    mocks.applyMatrixProfileUpdate.mockResolvedValue({
      accountId: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      profile: {
        displayNameUpdated: true,
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://example/avatar",
        uploadedAvatarSource: null,
        convertedAvatarFromHttp: false,
      },
      configPath: "channels.matrix.accounts.ops",
    });
  });

  it("parses snake_case vote params and forwards normalized selectors", async () => {
    const cfg = {} as CoreConfig;
    const result = await handleMatrixAction(
      {
        action: "pollVote",
        account_id: "main",
        room_id: "!room:example",
        poll_id: "$poll",
        poll_option_id: "a1",
        poll_option_ids: ["a2", ""],
        poll_option_index: "2",
        poll_option_indexes: ["1", "bogus"],
      },
      cfg,
    );

    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith("!room:example", "$poll", {
      cfg,
      accountId: "main",
      client: mocks.matrixClient,
      optionIds: ["a2", "a1"],
      optionIndexes: [1, 2],
    });
    expect(result.details).toEqual({
      ok: true,
      result: {
        eventId: "evt-poll-vote",
        roomId: "!room:example",
        pollId: "$poll",
        answerIds: ["a1", "a2"],
        labels: ["Pizza", "Sushi"],
        maxSelections: 2,
      },
    });
  });

  it("rejects missing poll ids", async () => {
    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          roomId: "!room:example",
          pollOptionIndex: 1,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollId required");
  });

  it("rejects fractional poll option indexes before voting", async () => {
    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          roomId: "!room:example",
          pollId: "$poll",
          pollOptionIndex: 1.5,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollOptionIndex must be a positive integer.");
    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          roomId: "!room:example",
          pollId: "$poll",
          pollOptionIndexes: [1, 2.5],
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollOptionIndexes must contain positive integers.");
    expect(mocks.voteMatrixPoll).not.toHaveBeenCalled();
  });

  it("accepts messageId as a pollId alias for poll votes", async () => {
    const cfg = {} as CoreConfig;
    await handleMatrixAction(
      {
        action: "pollVote",
        roomId: "!room:example",
        messageId: "$poll",
        pollOptionIndex: 1,
      },
      cfg,
    );

    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith("!room:example", "$poll", {
      cfg,
      client: mocks.matrixClient,
      optionIds: [],
      optionIndexes: [1],
    });
  });

  it("authorizes the room before reading the poll", async () => {
    mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
      new Error("Matrix read target is not allowed."),
    );

    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          roomId: "!blocked:example",
          pollId: "$poll",
          pollOptionIndex: 1,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");

    expect(mocks.voteMatrixPoll).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to add reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "react",
        accountId: "ops",
        roomId: "!room:example",
        messageId: "$msg",
        emoji: "👍",
      },
      cfg,
    );

    expect(mocks.reactMatrixMessage).toHaveBeenCalledWith("!room:example", "$msg", "👍", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
    });
  });

  it.each([
    {
      action: "react",
      params: { emoji: "👍" },
      providerCall: mocks.reactMatrixMessage,
    },
    {
      action: "editMessage",
      params: { content: "updated" },
      providerCall: mocks.editMatrixMessage,
    },
    {
      action: "deleteMessage",
      params: {},
      providerCall: mocks.deleteMatrixMessage,
    },
  ])("rejects blocked $action before mutating Matrix", async ({ action, params, providerCall }) => {
    mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
      new Error("Matrix read target is not allowed."),
    );
    const cfg = {
      channels: {
        matrix: {
          actions: {
            messages: true,
            reactions: true,
          },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action,
          roomId: "!blocked:example",
          messageId: "$msg",
          ...params,
        },
        cfg,
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");

    expect(providerCall).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to remove reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "react",
        account_id: "ops",
        room_id: "!room:example",
        message_id: "$msg",
        emoji: "👍",
        remove: true,
      },
      cfg,
    );

    expect(mocks.removeMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
      emoji: "👍",
    });
  });

  it("passes account-scoped opts and limit to reaction listing", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    const result = await handleMatrixAction(
      {
        action: "reactions",
        account_id: "ops",
        room_id: "!room:example",
        message_id: "$msg",
        limit: "5",
      },
      cfg,
    );

    expect(mocks.listMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
      limit: 5,
    });
    expect(result.details).toEqual({
      ok: true,
      reactions: [{ key: "👍", count: 1, users: ["@u:example"] }],
    });
  });

  it("rejects fractional reaction limits before listing reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await expect(
      handleMatrixAction(
        {
          action: "reactions",
          roomId: "!room:example",
          messageId: "$msg",
          limit: 5.5,
        },
        cfg,
      ),
    ).rejects.toThrow("limit must be a positive integer.");
    expect(mocks.listMatrixReactions).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to message sends", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "sendMessage",
        accountId: "ops",
        to: "room:!room:example",
        content: "hello",
        threadId: "$thread",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", "hello", {
      cfg,
      accountId: "ops",
      mediaUrl: undefined,
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replyToId: undefined,
      threadId: "$thread",
    });
  });

  it("accepts media-only message sends", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "sendMessage",
        accountId: "ops",
        to: "room:!room:example",
        mediaUrl: "file:///tmp/photo.png",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", undefined, {
      cfg,
      accountId: "ops",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replyToId: undefined,
      threadId: undefined,
    });
  });

  it("accepts shared media aliases and voice-send flags", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "sendMessage",
        accountId: "ops",
        to: "room:!room:example",
        path: "/tmp/clip.mp3",
        asVoice: true,
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", undefined, {
      cfg,
      accountId: "ops",
      mediaUrl: "/tmp/clip.mp3",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replyToId: undefined,
      threadId: undefined,
      audioAsVoice: true,
    });
  });

  it("passes mediaLocalRoots to profile updates", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "setProfile",
        accountId: "ops",
        avatarPath: "/tmp/avatar.jpg",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: undefined,
      avatarUrl: undefined,
      avatarPath: "/tmp/avatar.jpg",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
    });
  });

  it("passes account-scoped opts to pin listing", async () => {
    const cfg = { channels: { matrix: { actions: { pins: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "listPins",
        accountId: "ops",
        roomId: "!room:example",
      },
      cfg,
    );

    expect(mocks.listMatrixPins).toHaveBeenCalledWith("!room:example", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
    });
  });

  it.each([
    {
      action: "pinMessage",
      expected: mocks.pinMatrixMessage,
      expectedPinned: ["$existing", "$pin"],
    },
    {
      action: "unpinMessage",
      expected: mocks.unpinMatrixMessage,
      expectedPinned: ["$existing"],
    },
  ])(
    "authorizes $action before reading pinned state",
    async ({ action, expected, expectedPinned }) => {
      const cfg = { channels: { matrix: { actions: { pins: true } } } } as CoreConfig;
      const result = await handleMatrixAction(
        {
          action,
          accountId: "ops",
          roomId: "room:!room:example",
          messageId: "$pin",
        },
        cfg,
      );

      expect(expected).toHaveBeenCalledWith("!room:example", "$pin", {
        cfg,
        accountId: "ops",
        client: mocks.matrixClient,
      });
      expect(result.details).toEqual({ ok: true, pinned: expectedPinned });
    },
  );

  it.each(["pinMessage", "unpinMessage"])(
    "rejects blocked %s before reading or mutating pinned state",
    async (action) => {
      mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
        new Error("Matrix read target is not allowed."),
      );
      const cfg = { channels: { matrix: { actions: { pins: true } } } } as CoreConfig;

      await expect(
        handleMatrixAction(
          {
            action,
            roomId: "!blocked:example",
            messageId: "$pin",
          },
          cfg,
        ),
      ).rejects.toThrow("Matrix read target is not allowed.");

      expect(mocks.pinMatrixMessage).not.toHaveBeenCalled();
      expect(mocks.unpinMatrixMessage).not.toHaveBeenCalled();
      expect(mocks.listMatrixPins).not.toHaveBeenCalled();
    },
  );

  it("passes account-scoped opts to member and room info actions", async () => {
    const memberCfg = {
      channels: { matrix: { actions: { memberInfo: true } } },
    } as CoreConfig;
    await handleMatrixAction(
      {
        action: "memberInfo",
        accountId: "ops",
        userId: "@u:example",
        roomId: "!room:example",
      },
      memberCfg,
    );
    const roomCfg = { channels: { matrix: { actions: { channelInfo: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "channelInfo",
        accountId: "ops",
        roomId: "!room:example",
      },
      roomCfg,
    );

    expect(mocks.getMatrixMemberInfo).toHaveBeenCalledWith("@u:example", {
      cfg: memberCfg,
      accountId: "ops",
      roomId: "!room:example",
      client: mocks.matrixClient,
    });
    expect(mocks.getMatrixRoomInfo).toHaveBeenCalledWith("!room:example", {
      cfg: roomCfg,
      accountId: "ops",
      client: mocks.matrixClient,
    });
  });

  it("persists self-profile updates through the shared profile helper", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    const result = await handleMatrixAction(
      {
        action: "setProfile",
        account_id: "ops",
        display_name: "Ops Bot",
        avatar_url: "mxc://example/avatar",
      },
      cfg,
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
    });
    expect(result.details).toEqual({
      ok: true,
      accountId: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      profile: {
        displayNameUpdated: true,
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://example/avatar",
        uploadedAvatarSource: null,
        convertedAvatarFromHttp: false,
      },
      configPath: "channels.matrix.accounts.ops",
    });
  });

  it("accepts local avatar paths for self-profile updates", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "setProfile",
        accountId: "ops",
        path: "/tmp/avatar.jpg",
      },
      cfg,
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: undefined,
      avatarUrl: undefined,
      avatarPath: "/tmp/avatar.jpg",
    });
  });

  it("respects account-scoped action overrides when gating direct tool actions", async () => {
    await expect(
      handleMatrixAction(
        {
          action: "sendMessage",
          accountId: "ops",
          to: "room:!room:example",
          content: "hello",
        },
        {
          channels: {
            matrix: {
              actions: {
                messages: true,
              },
              accounts: {
                ops: {
                  actions: {
                    messages: false,
                  },
                },
              },
            },
          },
        } as CoreConfig,
      ),
    ).rejects.toThrow("Matrix messages are disabled.");
  });
});
