// Msteams tests cover resolve allowlist plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listTeamsByNameWithPageInfo,
  listChannelsForTeamWithPageInfo,
  normalizeQuery,
  resolveGraphToken,
  findGraphUsersByExactIdentity,
} = vi.hoisted(() => ({
  listTeamsByNameWithPageInfo: vi.fn(),
  listChannelsForTeamWithPageInfo: vi.fn(),
  normalizeQuery: vi.fn((value: string) => value.trim().toLowerCase()),
  resolveGraphToken: vi.fn(async () => "graph-token"),
  findGraphUsersByExactIdentity: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  listTeamsByNameWithPageInfo,
  listChannelsForTeamWithPageInfo,
  normalizeQuery,
  resolveGraphToken,
}));

vi.mock("./graph-users.js", () => ({
  findGraphUsersByExactIdentity,
}));

import {
  looksLikeMSTeamsTargetId,
  projectStableMSTeamsUserAllowlist,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsTeamsConfig,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

beforeEach(() => {
  listTeamsByNameWithPageInfo.mockReset();
  listChannelsForTeamWithPageInfo.mockReset();
  normalizeQuery.mockImplementation((value: string) => value.trim().toLowerCase());
  resolveGraphToken.mockReset().mockResolvedValue("graph-token");
  findGraphUsersByExactIdentity.mockReset();
});

describe("resolveMSTeamsUserAllowlist", () => {
  it("marks empty input unresolved", async () => {
    const [result] = await resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["  "] });
    expect(result).toEqual({ input: "  ", resolved: false });
  });

  it("resolves one exact Graph user identity", async () => {
    findGraphUsersByExactIdentity.mockResolvedValueOnce({
      items: [
        { id: "user-1", displayName: "Alice" },
        { id: "user-2", displayName: "Alice Two" },
      ],
      truncated: false,
    });
    const [result] = await resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["Alice"] });
    expect(result).toEqual({
      input: "Alice",
      resolved: true,
      id: "user-1",
      name: "Alice",
    });
  });

  it("rejects ambiguous and incomplete Graph user identities", async () => {
    findGraphUsersByExactIdentity
      .mockResolvedValueOnce({
        items: [
          { id: "user-1", displayName: "Alice" },
          { id: "user-2", mail: "alice" },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: [{ id: "user-1", displayName: "Alice" }],
        truncated: true,
      });

    await expect(resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["Alice"] })).resolves.toEqual([
      {
        input: "Alice",
        resolved: false,
        note: "user identity is ambiguous",
      },
    ]);
    await expect(resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["Alice"] })).resolves.toEqual([
      {
        input: "Alice",
        resolved: false,
        note: "user lookup incomplete",
      },
    ]);
  });

  it("keeps stable user IDs without acquiring a Graph token", async () => {
    await expect(
      resolveMSTeamsUserAllowlist({
        cfg: {},
        entries: ["user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      }),
    ).resolves.toEqual([
      {
        input: "user:40a1a0ed-4ff2-4164-a219-55518990c197",
        resolved: true,
        id: "40a1a0ed-4ff2-4164-a219-55518990c197",
      },
    ]);
    expect(resolveGraphToken).not.toHaveBeenCalled();
  });
});

describe("projectStableMSTeamsUserAllowlist", () => {
  it("keeps stable IDs, wildcards, and access groups while dropping mutable identities", () => {
    expect(
      projectStableMSTeamsUserAllowlist([
        "*",
        "accessGroup:operators",
        "msteams:user:40a1a0ed-4ff2-4164-a219-55518990c197",
        "Alice Example",
      ]),
    ).toEqual(["*", "accessGroup:operators", "40a1a0ed-4ff2-4164-a219-55518990c197"]);
  });
});

describe("resolveMSTeamsChannelAllowlist", () => {
  it("keeps configured Teams conversation IDs resolved without Graph lookup", async () => {
    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["19:team-general@thread.skype/19:roadmap@thread.skype"],
    });

    expect(result).toEqual({
      input: "19:team-general@thread.skype/19:roadmap@thread.skype",
      resolved: true,
      teamId: "19:team-general@thread.skype",
      teamName: "19:team-general@thread.skype",
      channelId: "19:roadmap@thread.skype",
      channelName: "19:roadmap@thread.skype",
    });
    expect(resolveGraphToken).not.toHaveBeenCalled();
    expect(listTeamsByNameWithPageInfo).not.toHaveBeenCalled();
    expect(listChannelsForTeamWithPageInfo).not.toHaveBeenCalled();
  });

  it("normalizes conversation-prefixed configured channel IDs", async () => {
    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["19:team-general@thread.tacv2/conversation:19:roadmap@thread.tacv2"],
    });

    expect(result).toEqual({
      input: "19:team-general@thread.tacv2/conversation:19:roadmap@thread.tacv2",
      resolved: true,
      teamId: "19:team-general@thread.tacv2",
      teamName: "19:team-general@thread.tacv2",
      channelId: "19:roadmap@thread.tacv2",
      channelName: "19:roadmap@thread.tacv2",
    });
    expect(resolveGraphToken).not.toHaveBeenCalled();
  });

  it("resolves team/channel by team name + channel display name", async () => {
    // After the fix, listChannelsForTeam is called once and reused for both
    // General channel resolution and channel matching.
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [{ id: "team-guid-1", displayName: "Product Team" }],
      truncated: false,
    });
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce({
      items: [
        { id: "19:general-conv-id@thread.tacv2", displayName: "General" },
        { id: "19:roadmap-conv-id@thread.tacv2", displayName: "Roadmap" },
      ],
      truncated: false,
    });

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Product Team/Roadmap"],
    });

    // teamId is now the General channel's conversation ID — not the Graph GUID —
    // because that's what Bot Framework sends as channelData.team.id at runtime.
    expect(result).toEqual({
      input: "Product Team/Roadmap",
      resolved: true,
      teamId: "19:general-conv-id@thread.tacv2",
      graphTeamId: "team-guid-1",
      teamName: "Product Team",
      channelId: "19:roadmap-conv-id@thread.tacv2",
      channelName: "Roadmap",
    });
  });

  it("uses General channel conversation ID as team key for team-only entry", async () => {
    // When no channel is specified we still resolve the General channel so the
    // stored key matches what Bot Framework sends as channelData.team.id.
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [{ id: "guid-engineering", displayName: "Engineering" }],
      truncated: false,
    });
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce({
      items: [
        { id: "19:eng-general@thread.tacv2", displayName: "General" },
        { id: "19:eng-standups@thread.tacv2", displayName: "Standups" },
      ],
      truncated: false,
    });

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Engineering"],
    });

    expect(result).toEqual({
      input: "Engineering",
      resolved: true,
      teamId: "19:eng-general@thread.tacv2",
      graphTeamId: "guid-engineering",
      teamName: "Engineering",
    });
  });

  it("fails closed when channel lookup fails", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [{ id: "guid-flaky", displayName: "Flaky Team" }],
      truncated: false,
    });
    listChannelsForTeamWithPageInfo.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Flaky Team"],
    });

    expect(result).toEqual({
      input: "Flaky Team",
      resolved: false,
      note: "channel lookup failed",
    });
  });

  it("fails closed when the Bot Framework team key cannot be identified", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [{ id: "guid-ops", displayName: "Operations" }],
      truncated: false,
    });
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce({
      items: [
        { id: "19:ops-announce@thread.tacv2", displayName: "Announcements" },
        { id: "19:ops-random@thread.tacv2", displayName: "Random" },
      ],
      truncated: false,
    });

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Operations"],
    });

    expect(result).toEqual({
      input: "Operations",
      resolved: false,
      graphTeamId: "guid-ops",
      teamName: "Operations",
      note: "General channel not found",
    });
  });

  it("does not enumerate channels for a Graph-keyed team-only projection", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [{ id: "guid-ops", displayName: "Operations" }],
      truncated: false,
    });

    await expect(
      resolveMSTeamsChannelAllowlist({
        cfg: {},
        entries: ["Operations"],
        teamIdMode: "graph",
      }),
    ).resolves.toEqual([
      {
        input: "Operations",
        resolved: true,
        teamId: "guid-ops",
        graphTeamId: "guid-ops",
        teamName: "Operations",
      },
    ]);
    expect(listChannelsForTeamWithPageInfo).not.toHaveBeenCalled();
  });

  it("rejects partial, ambiguous, and incomplete team or channel matches", async () => {
    listTeamsByNameWithPageInfo
      .mockResolvedValueOnce({
        items: [{ id: "team-1", displayName: "Product Team Extended" }],
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: [
          { id: "team-1", displayName: "Product Team" },
          { id: "team-2", displayName: "product team" },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: [{ id: "team-1", displayName: "Product Team" }],
        truncated: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: "team-1", displayName: "Product Team" }],
        truncated: false,
      });
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce({
      items: [
        { id: "general", displayName: "General" },
        { id: "channel-1", displayName: "Roadmap" },
        { id: "channel-2", displayName: "roadmap" },
      ],
      truncated: false,
    });

    const results = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Product Team", "Product Team", "Product Team", "Product Team/Roadmap"],
    });

    expect(results.map((result) => result.note)).toEqual([
      "team not found",
      "team name is ambiguous",
      "team lookup incomplete",
      "channel name is ambiguous",
    ]);
    expect(results.every((result) => !result.resolved)).toBe(true);
  });
});

describe("resolveMSTeamsTeamsConfig", () => {
  it("adds resolved stable keys while preserving the configured policy", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [{ id: "team-guid-1", displayName: "Product Team" }],
      truncated: false,
    });
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce({
      items: [
        { id: "19:general@thread.tacv2", displayName: "General" },
        { id: "19:roadmap@thread.tacv2", displayName: "Roadmap" },
      ],
      truncated: false,
    });

    const result = await resolveMSTeamsTeamsConfig({
      cfg: {},
      teamIdMode: "bot-framework",
      teams: {
        "Product Team": {
          requireMention: false,
          channels: {
            Roadmap: { requireMention: true },
          },
        },
      },
    });

    expect(result.mapping).toEqual([
      "Product Team/Roadmap→19:general@thread.tacv2/19:roadmap@thread.tacv2",
    ]);
    expect(result.teams["19:general@thread.tacv2"]).toMatchObject({
      requireMention: false,
      channels: {
        "19:roadmap@thread.tacv2": { requireMention: true },
      },
    });
    expect(result.teams["Product Team"]).toBeUndefined();
  });

  it("builds a Graph-keyed projection for action routing", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [{ id: "11111111-1111-1111-1111-111111111111", displayName: "Product Team" }],
      truncated: false,
    });
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce({
      items: [
        { id: "19:general@thread.tacv2", displayName: "General" },
        { id: "19:roadmap@thread.tacv2", displayName: "Roadmap" },
      ],
      truncated: false,
    });

    const result = await resolveMSTeamsTeamsConfig({
      cfg: {},
      teamIdMode: "graph",
      teams: {
        "Product Team": {
          channels: {
            Roadmap: { requireMention: true },
          },
        },
      },
    });

    expect(result.mapping).toEqual([
      "Product Team/Roadmap→11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
    ]);
    expect(result.teams["11111111-1111-1111-1111-111111111111"]).toMatchObject({
      channels: {
        "19:roadmap@thread.tacv2": { requireMention: true },
      },
    });
  });

  it("drops unresolved mutable keys while retaining wildcard and stable policy", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce({
      items: [],
      truncated: false,
    });

    const result = await resolveMSTeamsTeamsConfig({
      cfg: {},
      teamIdMode: "bot-framework",
      teams: {
        "*": {
          channels: {
            "*": { requireMention: true },
            Mutable: { requireMention: false },
            "19:stable@thread.tacv2": { requireMention: false },
          },
        },
        Missing: {
          channels: {
            Roadmap: { requireMention: false },
          },
        },
      },
    });

    expect(result.teams).toEqual({
      "*": {
        channels: {
          "*": { requireMention: true },
          "19:stable@thread.tacv2": { requireMention: false },
        },
      },
    });
    expect(result.unresolved).toEqual(["*/Mutable", "Missing/Roadmap"]);
  });
});

describe("looksLikeMSTeamsTargetId", () => {
  // Regression suite for https://github.com/openclaw/openclaw/issues/58001:
  // cron announce delivery rejected valid Teams conversation ids because the
  // validator only matched the `conversation:`-prefixed and `@thread`-suffixed
  // forms. It must now accept every documented Bot Framework + Graph format.
  it.each([
    "conversation:19:abc@thread.tacv2",
    "conversation:a:1abc",
    "conversation:8:orgid:2d8c2d2c-1111-2222-3333-444444444444",
  ])("accepts conversation-prefixed ids (%s)", (raw) => {
    expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
  });

  it.each(["19:AdviChannelId@thread.tacv2", "19:abc@thread.tacv2", "19:abc@thread.skype"])(
    "accepts bare channel/group conversation ids (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
    },
  );

  it("accepts the Graph 1:1 chat thread format", () => {
    expect(
      looksLikeMSTeamsTargetId(
        "19:40a1a0ed4ff24164a21955518990c197_2d8c2d2c11112222@unq.gbl.spaces",
      ),
    ).toBe(true);
  });

  it.each(["a:1abc123def", "a:1xyz-abc_def", "A:1UPPER"])(
    "accepts Bot Framework personal chat ids (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
    },
  );

  it.each(["8:orgid:2d8c2d2c-1111-2222-3333-444444444444", "8:orgid:user-object-id"])(
    "accepts Bot Framework org-scoped personal chat ids (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
    },
  );

  it("accepts Bot Framework user ids", () => {
    expect(looksLikeMSTeamsTargetId("29:1a2b3c4d5e6f")).toBe(true);
  });

  it("accepts user:<aad-object-id> ids", () => {
    expect(looksLikeMSTeamsTargetId("user:40a1a0ed-4ff2-4164-a219-55518990c197")).toBe(true);
  });

  it.each(["", "   ", "user:John Smith", "Product Team/Roadmap", "Engineering", "hello"])(
    "rejects non-id inputs (%s)",
    (raw) => {
      expect(looksLikeMSTeamsTargetId(raw)).toBe(false);
    },
  );

  it("normalizes leading/trailing whitespace before classifying", () => {
    expect(looksLikeMSTeamsTargetId("  19:abc@thread.tacv2  ")).toBe(true);
  });
});
