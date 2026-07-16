import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  searchGraphUsersMock,
  listTeamsByNameMock,
  listChannelsForTeamMock,
  normalizeQueryMock,
  resolveGraphTokenMock,
} = vi.hoisted(() => {
  return {
    searchGraphUsersMock: vi.fn(),
    listTeamsByNameMock: vi.fn(),
    listChannelsForTeamMock: vi.fn(),
    normalizeQueryMock: vi.fn((value?: string | null) => value?.trim() ?? ""),
    resolveGraphTokenMock: vi.fn(),
  };
});

vi.mock("./graph-users.js", () => {
  return { searchGraphUsers: searchGraphUsersMock };
});

vi.mock("./graph.js", () => {
  return {
    listTeamsByName: listTeamsByNameMock,
    listChannelsForTeam: listChannelsForTeamMock,
    normalizeQuery: normalizeQueryMock,
    resolveGraphToken: resolveGraphTokenMock,
  };
});

import { listMSTeamsDirectoryGroupsLive, listMSTeamsDirectoryPeersLive } from "./directory-live.js";

describe("msteams directory live", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    normalizeQueryMock.mockImplementation((value?: string | null) => value?.trim() ?? "");
  });

  it("returns normalized peer entries and skips users without ids", async () => {
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    searchGraphUsersMock.mockResolvedValue([
      {
        id: "user-1",
        displayName: "Alice",
        userPrincipalName: "alice@example.com",
      },
      {
        id: "user-2",
        displayName: "Bob",
        mail: "bob@example.com",
      },
      {
        displayName: "Missing Id",
      },
    ]);

    await expect(
      listMSTeamsDirectoryPeersLive({
        cfg: {},
        query: "  ali  ",
      }),
    ).resolves.toEqual([
      {
        kind: "user",
        id: "user:user-1",
        name: "Alice",
        handle: "@alice@example.com",
        raw: {
          id: "user-1",
          displayName: "Alice",
          userPrincipalName: "alice@example.com",
        },
      },
      {
        kind: "user",
        id: "user:user-2",
        name: "Bob",
        handle: "@bob@example.com",
        raw: {
          id: "user-2",
          displayName: "Bob",
          mail: "bob@example.com",
        },
      },
    ]);

    expect(searchGraphUsersMock).toHaveBeenCalledWith({
      token: "graph-token",
      query: "ali",
      top: 20,
    });
  });

  it("returns team entries without channel queries and honors limits", async () => {
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    listTeamsByNameMock.mockResolvedValue([
      { id: "team-1", displayName: "Platform" },
      { id: "team-2", displayName: "Infra" },
    ]);

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "platform",
        limit: 1,
      }),
    ).resolves.toEqual([
      {
        kind: "group",
        id: "team:team-1",
        name: "Platform",
        handle: "#Platform",
        raw: { id: "team-1", displayName: "Platform" },
      },
    ]);
  });

  it("searches channels within matching teams when a team/channel query is used", async () => {
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    listTeamsByNameMock.mockResolvedValue([
      { id: "team-1", displayName: "Platform" },
      { id: "team-2", displayName: "Infra" },
    ]);
    listChannelsForTeamMock
      .mockResolvedValueOnce([
        { id: "chan-1", displayName: "Deployments" },
        { id: "chan-2", displayName: "General" },
      ])
      .mockResolvedValueOnce([{ id: "chan-3", displayName: "Deployments-West" }]);

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "plat / deploy",
      }),
    ).resolves.toEqual([
      {
        kind: "group",
        id: "conversation:chan-1",
        name: "Platform/Deployments",
        handle: "#Deployments",
        raw: { id: "chan-1", displayName: "Deployments" },
      },
      {
        kind: "group",
        id: "conversation:chan-3",
        name: "Infra/Deployments-West",
        handle: "#Deployments-West",
        raw: { id: "chan-3", displayName: "Deployments-West" },
      },
    ]);

    expect(listTeamsByNameMock).toHaveBeenCalledWith("graph-token", "plat");
  });
});
