import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig } from "../types.js";
import { withAuthorizedMatrixReadTarget } from "./read-policy.js";
import type { MatrixClient } from "./sdk.js";

function createClient(
  members: string[],
  directFlag: boolean | null = null,
  aliases: { canonicalAlias?: string; altAliases?: string[] } = {},
  roomName?: string,
  overrides: Partial<MatrixClient> = {},
): MatrixClient {
  return {
    dms: {
      update: vi.fn(async () => false),
      isDm: vi.fn(() => false),
    },
    getJoinedRoomMembers: vi.fn(async () => members),
    getRoomStateEvent: vi.fn(async (_roomId: string, eventType: string) => {
      if (eventType === "m.room.canonical_alias") {
        return { alias: aliases.canonicalAlias, alt_aliases: aliases.altAliases };
      }
      if (eventType === "m.room.name") {
        return roomName ? { name: roomName } : {};
      }
      return directFlag === null ? {} : { is_direct: directFlag };
    }),
    getUserId: vi.fn(async () => "@bot:example.org"),
    stop: vi.fn(),
    ...overrides,
  } as unknown as MatrixClient;
}

describe("Matrix read policy", () => {
  beforeEach(() => {
    installMatrixTestRuntime();
  });

  it("allows configured rooms and rejects other rooms before the read", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org", "@bob:example.org"]);
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          groups: {
            "!allowed:example.org": {},
          },
        },
      },
    } as CoreConfig;
    const read = vi.fn(async () => "ok");

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg,
        roomId: "!allowed:example.org",
        opts: { client },
        run: read,
      }),
    ).resolves.toBe("ok");
    await expect(
      withAuthorizedMatrixReadTarget({
        cfg,
        roomId: "!blocked:example.org",
        opts: { client },
        run: read,
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("authorizes direct rooms by their remote member", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org"], true);
    const read = vi.fn(async () => "ok");

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              dm: {
                policy: "allowlist",
                allowFrom: ["@alice:example.org"],
              },
            },
          },
        } as CoreConfig,
        roomId: "!dm:example.org",
        opts: { client },
        run: read,
      }),
    ).resolves.toBe("ok");
  });

  it("keeps a restrictive DM allowlist effective under open policy", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org"], true);
    const read = vi.fn(async () => "ok");

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              dm: {
                policy: "open",
                allowFrom: ["@bob:example.org"],
              },
            },
          },
        } as CoreConfig,
        roomId: "!dm:example.org",
        opts: { client },
        run: read,
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(read).not.toHaveBeenCalled();
  });

  it("allows wildcard DM reads under any non-disabled policy", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org"], true);

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              dm: {
                policy: "pairing",
                allowFrom: ["matrix:*"],
              },
            },
          },
        } as CoreConfig,
        roomId: "!dm:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("does not guess that an unmarked two-member room is a DM", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org"]);
    const read = vi.fn(async () => "ok");

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "open",
              dm: { policy: "allowlist", allowFrom: [] },
            },
          },
        } as CoreConfig,
        roomId: "!ambiguous:example.org",
        opts: { client },
        run: read,
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "member lookup fails",
      overrides: {
        getJoinedRoomMembers: vi.fn(async () => {
          throw new Error("members unavailable");
        }),
      },
    },
    {
      name: "self lookup fails",
      overrides: {
        getUserId: vi.fn(async () => {
          throw new Error("whoami unavailable");
        }),
      },
    },
  ])("fails closed when $name", async ({ overrides }) => {
    const client = createClient(
      ["@bot:example.org", "@alice:example.org"],
      true,
      {},
      undefined,
      overrides,
    );
    const read = vi.fn(async () => "ok");

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "open",
              dm: { policy: "disabled" },
            },
          },
        } as CoreConfig,
        roomId: "!unknown:example.org",
        opts: { client },
        run: read,
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(read).not.toHaveBeenCalled();
  });

  it("allows the trusted current room without broadening other targets", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org", "@bob:example.org"]);
    const read = vi.fn(async () => "ok");
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          groups: {},
        },
      },
    } as CoreConfig;

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg,
        roomId: "!current:example.org",
        context: {
          currentChannelProvider: "matrix",
          currentChannelId: "!current:example.org",
          requesterAccountId: "default",
        },
        opts: { client },
        run: read,
      }),
    ).resolves.toBe("ok");
    await expect(
      withAuthorizedMatrixReadTarget({
        cfg,
        roomId: "!other:example.org",
        context: {
          currentChannelProvider: "matrix",
          currentChannelId: "!current:example.org",
          requesterAccountId: "default",
        },
        opts: { client },
        run: read,
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
  });

  it("preserves the trusted direct type for the current room", async () => {
    const getJoinedRoomMembers = vi.fn(async () => ["@bot:example.org", "@alice:example.org"]);
    const client = createClient([], null, {}, undefined, { getJoinedRoomMembers });
    const read = vi.fn(async () => "ok");

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "disabled",
              dm: { policy: "pairing", allowFrom: [] },
            },
          },
        } as CoreConfig,
        roomId: "!current-dm:example.org",
        context: {
          currentChannelProvider: "matrix",
          currentChannelId: "room:!current-dm:example.org",
          currentChatType: "direct",
          requesterAccountId: "default",
        },
        opts: { client },
        run: read,
      }),
    ).resolves.toBe("ok");
    expect(getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("uses the global group policy when the account does not override it", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org", "@bob:example.org"]);

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
            matrix: {},
          },
        } as CoreConfig,
        roomId: "!global-open:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("allows unmatched group rooms under an open group policy", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org", "@bob:example.org"]);

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "open",
              groups: {
                "!other:example.org": {},
              },
            },
          },
        } as CoreConfig,
        roomId: "!unmatched:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("matches configured room aliases before applying direct-message policy", async () => {
    const client = createClient(
      ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
      null,
      {
        canonicalAlias: "#ops:example.org",
      },
    );

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "allowlist",
              groups: {
                "#ops:example.org": {},
              },
              dm: { policy: "disabled" },
            },
          },
        } as CoreConfig,
        roomId: "!ops:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("resolves aliases before applying a disabled wildcard room policy", async () => {
    const resolveRoom = vi.fn(async () => "!ops:example.org");
    const client = createClient(
      ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
      null,
      {
        canonicalAlias: "#ops:example.org",
      },
      undefined,
      { resolveRoom },
    );

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "allowlist",
              groups: {
                "!ops:example.org": {},
                "*": { enabled: false },
              },
            },
          },
        } as CoreConfig,
        roomId: "#ops:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
    expect(resolveRoom).toHaveBeenCalledWith("#ops:example.org");
  });

  it("treats explicitly configured two-member rooms as groups like ingress", async () => {
    const getJoinedRoomMembers = vi.fn(async () => ["@bot:example.org", "@alice:example.org"]);
    const client = createClient(
      [],
      true,
      {
        canonicalAlias: "#ops:example.org",
      },
      undefined,
      { getJoinedRoomMembers },
    );

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "allowlist",
              groups: {
                "#ops:example.org": {},
              },
              dm: { policy: "disabled" },
            },
          },
        } as CoreConfig,
        roomId: "!ops:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
    expect(getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("does not let wildcard room config override direct-message policy", async () => {
    const client = createClient(["@bot:example.org", "@alice:example.org"], true);

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "allowlist",
              groups: {
                "*": {},
              },
              dm: { policy: "disabled" },
            },
          },
        } as CoreConfig,
        roomId: "!dm:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
  });

  it("matches configured room names only when mutable matching is enabled", async () => {
    const client = createClient(
      ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
      null,
      {},
      "General",
    );

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              dangerouslyAllowNameMatching: true,
              groupPolicy: "allowlist",
              groups: {
                General: {},
              },
            },
          },
        } as CoreConfig,
        roomId: "!general:example.org",
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it.each([
    "!blocked:example.org",
    "room:!blocked:example.org",
    "matrix:room:!blocked:example.org",
    "channel:!blocked:example.org",
  ])("rejects explicitly disabled room target %s before provider access", async (roomId) => {
    const getRoomStateEvent = vi.fn(async () => ({}));
    const getJoinedRoomMembers = vi.fn(async () => [
      "@bot:example.org",
      "@alice:example.org",
      "@bob:example.org",
    ]);
    const client = createClient([], null, {}, undefined, {
      getRoomStateEvent,
      getJoinedRoomMembers,
    });

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "open",
              groups: {
                "!blocked:example.org": { enabled: false },
              },
            },
          },
        } as CoreConfig,
        roomId,
        context: {
          currentChannelProvider: "matrix",
          currentChannelId: "!blocked:example.org",
          requesterAccountId: "default",
        },
        opts: { client },
        run: async () => "ok",
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(getRoomStateEvent).not.toHaveBeenCalled();
    expect(getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it.each(["!other-account:example.org", "matrix:channel:!other-account:example.org"])(
    "rejects wrong-account room target %s before provider access",
    async (roomId) => {
      const getRoomStateEvent = vi.fn(async () => ({}));
      const getJoinedRoomMembers = vi.fn(async () => [
        "@bot:example.org",
        "@alice:example.org",
        "@bob:example.org",
      ]);
      const client = createClient([], null, {}, undefined, {
        getRoomStateEvent,
        getJoinedRoomMembers,
      });

      await expect(
        withAuthorizedMatrixReadTarget({
          cfg: {
            channels: {
              matrix: {
                groupPolicy: "open",
                groups: {
                  "!other-account:example.org": { account: "other" },
                },
              },
            },
          } as CoreConfig,
          accountId: "default",
          roomId,
          opts: { client },
          run: async () => "ok",
        }),
      ).rejects.toThrow("Matrix read target is not allowed.");
      expect(getRoomStateEvent).not.toHaveBeenCalled();
      expect(getJoinedRoomMembers).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "group",
      members: ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
      directFlag: null,
    },
    {
      name: "direct room",
      members: ["@bot:example.org", "@alice:example.org"],
      directFlag: true,
    },
  ])("lets a direct operator read an unconfigured $name", async ({ members, directFlag }) => {
    const client = createClient(members, directFlag);

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: {
          channels: {
            matrix: {
              groupPolicy: "allowlist",
              dm: { policy: "pairing", allowFrom: [] },
            },
          },
        } as CoreConfig,
        roomId: "!operator:example.org",
        context: { conversationReadOrigin: "direct-operator" },
        opts: { client },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it.each([
    {
      name: "disabled room",
      cfg: {
        groupPolicy: "open",
        groups: { "!blocked:example.org": { enabled: false } },
      },
      members: ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
    },
    {
      name: "wrong-account room",
      cfg: {
        groupPolicy: "open",
        groups: { "!blocked:example.org": { account: "other" } },
      },
      members: ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
    },
    {
      name: "disabled direct-message scope",
      cfg: {
        groupPolicy: "open",
        dm: { policy: "disabled" },
      },
      members: ["@bot:example.org", "@alice:example.org"],
      directFlag: true,
    },
  ])("keeps $name blocked for direct operators", async ({ cfg, members, directFlag }) => {
    const client = createClient(members, directFlag ?? null);

    await expect(
      withAuthorizedMatrixReadTarget({
        cfg: { channels: { matrix: cfg } } as CoreConfig,
        accountId: "default",
        roomId: "!blocked:example.org",
        context: { conversationReadOrigin: "direct-operator" },
        opts: { client },
        run: async () => "ok",
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
  });
});
