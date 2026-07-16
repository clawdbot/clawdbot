import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listMattermostAccountIdsMock,
  resolveMattermostAccountMock,
  createMattermostClientMock,
  fetchMattermostMeMock,
} = vi.hoisted(() => {
  return {
    listMattermostAccountIdsMock: vi.fn(),
    resolveMattermostAccountMock: vi.fn(),
    createMattermostClientMock: vi.fn(),
    fetchMattermostMeMock: vi.fn(),
  };
});

vi.mock("./accounts.js", () => {
  return {
    listMattermostAccountIds: listMattermostAccountIdsMock,
    resolveMattermostAccount: resolveMattermostAccountMock,
  };
});

vi.mock("./client.js", () => {
  return {
    createMattermostClient: createMattermostClientMock,
    fetchMattermostMe: fetchMattermostMeMock,
  };
});

let listMattermostDirectoryGroups: typeof import("./directory.js").listMattermostDirectoryGroups;
let listMattermostDirectoryPeers: typeof import("./directory.js").listMattermostDirectoryPeers;

describe("mattermost directory", () => {
  beforeAll(async () => {
    ({ listMattermostDirectoryGroups, listMattermostDirectoryPeers } =
      await import("./directory.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates channels across enabled accounts and skips failing accounts", async () => {
    const clientA = {
      token: "token-a",
      request: vi.fn().mockResolvedValueOnce([
        { id: "chan-1", type: "O", name: "alerts", display_name: "Alerts" },
        { id: "chan-2", type: "P", name: "ops", display_name: "Ops" },
        { id: "chan-3", type: "D", name: "dm", display_name: "Direct" },
      ]),
    };
    const clientB = {
      token: "token-b",
      request: vi.fn().mockRejectedValue(new Error("expired token")),
    };
    const clientC = {
      token: "token-c",
      request: vi.fn().mockResolvedValueOnce([
        { id: "chan-2", type: "P", name: "ops", display_name: "Ops" },
        { id: "chan-4", type: "O", name: "infra", display_name: "Infra" },
      ]),
    };

    listMattermostAccountIdsMock.mockReturnValue(["default", "alerts", "infra"]);
    resolveMattermostAccountMock.mockImplementation(({ accountId }) => {
      if (accountId === "disabled") {
        return { enabled: false };
      }
      return { enabled: true, botToken: `token-${accountId}`, baseUrl: "https://chat.example.com" };
    });
    createMattermostClientMock
      .mockReturnValueOnce(clientA)
      .mockReturnValueOnce(clientB)
      .mockReturnValueOnce(clientC);
    fetchMattermostMeMock.mockResolvedValue({ id: "me-1" });

    await expect(
      listMattermostDirectoryGroups({
        cfg: {} as never,
        runtime: {} as never,
        query: "  op  ",
      }),
    ).resolves.toEqual([{ kind: "group", id: "channel:chan-2", name: "ops", handle: "Ops" }]);
  });

  it("uses the first healthy client for peers and filters self and blanks", async () => {
    const client = {
      token: "token-default",
      request: vi
        .fn()
        .mockResolvedValueOnce([{ id: "team-1" }])
        .mockResolvedValueOnce([{ user_id: "me-1" }, { user_id: "user-1" }, { user_id: "user-2" }])
        .mockResolvedValueOnce([
          {
            id: "user-1",
            username: "alice",
            first_name: "Alice",
            last_name: "Ng",
          },
          {
            id: "user-2",
            username: "bob",
            nickname: "Bobby",
          },
          {
            id: "me-1",
            username: "self",
          },
        ]),
    };

    listMattermostAccountIdsMock.mockReturnValue(["default"]);
    resolveMattermostAccountMock.mockReturnValue({
      enabled: true,
      botToken: "token-default",
      baseUrl: "https://chat.example.com",
    });
    createMattermostClientMock.mockReturnValue(client);
    fetchMattermostMeMock.mockResolvedValue({ id: "me-1" });

    await expect(
      listMattermostDirectoryPeers({
        cfg: {} as never,
        runtime: {} as never,
      }),
    ).resolves.toEqual([
      { kind: "user", id: "user:user-1", name: "alice", handle: "Alice Ng" },
      { kind: "user", id: "user:user-2", name: "bob", handle: "Bobby" },
    ]);
  });

  it("uses user search when a query is present and applies limits", async () => {
    const client = {
      token: "token-default",
      request: vi
        .fn()
        .mockResolvedValueOnce([{ id: "team-1" }])
        .mockResolvedValueOnce([
          { id: "user-1", username: "alice", first_name: "Alice", last_name: "Ng" },
          { id: "user-2", username: "alex", nickname: "Lex" },
        ]),
    };

    listMattermostAccountIdsMock.mockReturnValue(["default"]);
    resolveMattermostAccountMock.mockReturnValue({
      enabled: true,
      botToken: "token-default",
      baseUrl: "https://chat.example.com",
    });
    createMattermostClientMock.mockReturnValue(client);
    fetchMattermostMeMock.mockResolvedValue({ id: "me-1" });

    await expect(
      listMattermostDirectoryPeers({
        cfg: {} as never,
        runtime: {} as never,
        query: "  ali  ",
        limit: 1,
      }),
    ).resolves.toEqual([{ kind: "user", id: "user:user-1", name: "alice", handle: "Alice Ng" }]);

    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "/users/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ term: "ali", team_id: "team-1" }),
      }),
    );
  });
});
