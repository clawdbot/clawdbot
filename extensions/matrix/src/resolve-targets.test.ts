import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../runtime-api.js";

vi.mock("./directory-live.js", () => ({
  listMatrixDirectoryPeersLive: vi.fn(),
  listMatrixDirectoryGroupsLive: vi.fn(),
}));

let listMatrixDirectoryGroupsLive: typeof import("./directory-live.js").listMatrixDirectoryGroupsLive;
let listMatrixDirectoryPeersLive: typeof import("./directory-live.js").listMatrixDirectoryPeersLive;
let resolveMatrixTargets: typeof import("./resolve-targets.js").resolveMatrixTargets;

async function resolveUserTarget(input = "Alice") {
  const [result] = await resolveMatrixTargets({
    cfg: {},
    inputs: [input],
    kind: "user",
  });
  return result;
}

describe("resolveMatrixTargets (users)", () => {
  beforeAll(async () => {
    ({ listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } =
      await import("./directory-live.js"));
    ({ resolveMatrixTargets } = await import("./resolve-targets.js"));
  });

  beforeEach(() => {
    vi.mocked(listMatrixDirectoryPeersLive).mockReset();
    vi.mocked(listMatrixDirectoryGroupsLive).mockReset();
  });

  it("resolves exact unique display name matches", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { kind: "user", id: "@alice:example.org", name: "Alice" },
    ];
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue(matches);

    const result = await resolveUserTarget();

    expect(result?.resolved).toBe(true);
    expect(result?.id).toBe("@alice:example.org");
    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledWith({
      cfg: {},
      accountId: undefined,
      query: "Alice",
      limit: 5,
    });
  });

  it("does not resolve ambiguous or non-exact matches", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { kind: "user", id: "@alice:example.org", name: "Alice" },
      { kind: "user", id: "@alice:evil.example", name: "Alice" },
    ];
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue(matches);

    const result = await resolveUserTarget();

    expect(result?.resolved).toBe(false);
    expect(result?.note).toMatch(/use full Matrix ID/i);
  });

  it("prefers exact group matches over first partial result", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { kind: "group", id: "!one:example.org", name: "General", handle: "#general" },
      { kind: "group", id: "!two:example.org", name: "Team", handle: "#team" },
    ];
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue(matches);

    const [result] = await resolveMatrixTargets({
      cfg: {},
      inputs: ["#team"],
      kind: "group",
    });

    expect(result?.resolved).toBe(true);
    expect(result?.id).toBe("!two:example.org");
    expect(result?.note).toBeUndefined();
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledWith({
      cfg: {},
      accountId: undefined,
      query: "#team",
      limit: 5,
    });
  });

  it("threads accountId into live Matrix target lookups", async () => {
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue([
      { kind: "user", id: "@alice:example.org", name: "Alice" },
    ]);
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue([
      { kind: "group", id: "!team:example.org", name: "Team", handle: "#team" },
    ]);

    await resolveMatrixTargets({
      cfg: {},
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
    });
    await resolveMatrixTargets({
      cfg: {},
      accountId: "ops",
      inputs: ["#team"],
      kind: "group",
    });

    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledWith({
      cfg: {},
      accountId: "ops",
      query: "Alice",
      limit: 5,
    });
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledWith({
      cfg: {},
      accountId: "ops",
      query: "#team",
      limit: 5,
    });
  });

  it("reuses directory lookups for normalized duplicate inputs", async () => {
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue([
      { kind: "user", id: "@alice:example.org", name: "Alice" },
    ]);
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue([
      { kind: "group", id: "!team:example.org", name: "Team", handle: "#team" },
    ]);

    const userResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["Alice", " alice "],
      kind: "user",
    });
    const groupResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["#team", "#team"],
      kind: "group",
    });

    expect(userResults.every((entry) => entry.resolved)).toBe(true);
    expect(groupResults.every((entry) => entry.resolved)).toBe(true);
    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledTimes(1);
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("accepts prefixed fully qualified ids without directory lookups", async () => {
    const userResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["matrix:user:@alice:example.org"],
      kind: "user",
    });
    const groupResults = await resolveMatrixTargets({
      cfg: {},
      inputs: ["matrix:room:!team:example.org"],
      kind: "group",
    });

    expect(userResults).toEqual([
      {
        input: "matrix:user:@alice:example.org",
        resolved: true,
        id: "@alice:example.org",
      },
    ]);
    expect(groupResults).toEqual([
      {
        input: "matrix:room:!team:example.org",
        resolved: true,
        id: "!team:example.org",
      },
    ]);
    expect(listMatrixDirectoryPeersLive).not.toHaveBeenCalled();
    expect(listMatrixDirectoryGroupsLive).not.toHaveBeenCalled();
  });
});
