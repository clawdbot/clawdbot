import { describe, expect, it } from "vitest";
import {
  createInspectedDirectoryEntriesLister,
  createResolvedDirectoryEntriesLister,
  listDirectoryEntriesFromSources,
  listInspectedDirectoryEntriesFromSources,
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryEntriesFromSources,
  listResolvedDirectoryUserEntriesFromAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
} from "./directory-config-helpers.js";

function expectUserDirectoryEntries(entries: unknown) {
  expect(entries).toEqual([
    { kind: "user", id: "alice" },
    { kind: "user", id: "carla" },
  ]);
}

describe("listDirectoryUserEntriesFromAllowFrom", () => {
  it("normalizes, deduplicates, filters, and limits user ids", () => {
    const entries = listDirectoryUserEntriesFromAllowFrom({
      allowFrom: ["", "*", "  user:Alice ", "user:alice", "user:Bob", "user:Carla"],
      normalizeId: (entry) => entry.replace(/^user:/i, "").toLowerCase(),
      query: "a",
      limit: 2,
    });

    expectUserDirectoryEntries(entries);
  });
});

describe("listDirectoryGroupEntriesFromMapKeys", () => {
  it("extracts normalized group ids from map keys", () => {
    const entries = listDirectoryGroupEntriesFromMapKeys({
      groups: {
        "*": {},
        " Space/A ": {},
        "space/b": {},
      },
      normalizeId: (entry) => entry.toLowerCase().replace(/\s+/g, ""),
    });

    expect(entries).toEqual([
      { kind: "group", id: "space/a" },
      { kind: "group", id: "space/b" },
    ]);
  });
});

describe("listDirectoryUserEntriesFromAllowFromAndMapKeys", () => {
  it("merges allowFrom and map keys with dedupe/query/limit", () => {
    const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
      allowFrom: ["user:alice", "user:bob"],
      map: {
        "user:carla": {},
        "user:alice": {},
      },
      normalizeAllowFromId: (entry) => entry.replace(/^user:/i, ""),
      normalizeMapKeyId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
      limit: 2,
    });

    expectUserDirectoryEntries(entries);
  });
});

describe("listDirectoryGroupEntriesFromMapKeysAndAllowFrom", () => {
  it("merges groups keys and group allowFrom entries", () => {
    const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
      groups: {
        "team/a": {},
      },
      allowFrom: ["team/b", "team/a"],
      query: "team/",
    });

    expect(entries).toEqual([
      { kind: "group", id: "team/a" },
      { kind: "group", id: "team/b" },
    ]);
  });
});

describe("listDirectoryEntriesFromSources", () => {
  it("merges source iterables with dedupe/query/limit", () => {
    const entries = listDirectoryEntriesFromSources({
      kind: "user",
      sources: [
        ["user:alice", "user:bob"],
        ["user:carla", "user:alice"],
      ],
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
      limit: 2,
    });

    expectUserDirectoryEntries(entries);
  });
});

describe("listInspectedDirectoryEntriesFromSources", () => {
  it("returns empty when the inspected account is missing", () => {
    const entries = listInspectedDirectoryEntriesFromSources({
      cfg: {} as never,
      kind: "user",
      inspectAccount: () => null,
      resolveSources: () => [["user:alice"]],
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
    });

    expect(entries).toStrictEqual([]);
  });

  it("lists entries from inspected account sources", () => {
    const entries = listInspectedDirectoryEntriesFromSources({
      cfg: {} as never,
      kind: "group",
      inspectAccount: () => ({ ids: [["room:a"], ["room:b", "room:a"]] }),
      resolveSources: (account) => account.ids,
      normalizeId: (entry) => entry.replace(/^room:/i, ""),
      query: "a",
    });

    expect(entries).toEqual([{ kind: "group", id: "a" }]);
  });
});

describe("createInspectedDirectoryEntriesLister", () => {
  it("builds a reusable inspected-account lister", async () => {
    const listGroups = createInspectedDirectoryEntriesLister({
      kind: "group",
      inspectAccount: () => ({ ids: [["room:a"], ["room:b", "room:a"]] }),
      resolveSources: (account) => account.ids,
      normalizeId: (entry) => entry.replace(/^room:/i, ""),
    });

    await expect(listGroups({ cfg: {} as never, query: "a" })).resolves.toEqual([
      { kind: "group", id: "a" },
    ]);
  });
});

describe("resolved account directory helpers", () => {
  const cfg = {} as never;
  const resolveAccount = () => ({
    allowFrom: ["user:alice", "user:bob"],
    groups: { "room:a": {}, "room:b": {} },
  });

  it("lists user entries from resolved account allowFrom", () => {
    const entries = listResolvedDirectoryUserEntriesFromAllowFrom({
      cfg,
      resolveAccount,
      resolveAllowFrom: (account) => account.allowFrom,
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
    });

    expect(entries).toEqual([{ kind: "user", id: "alice" }]);
  });

  it("lists group entries from resolved account map keys", () => {
    const entries = listResolvedDirectoryGroupEntriesFromMapKeys({
      cfg,
      resolveAccount,
      resolveGroups: (account) => account.groups,
      normalizeId: (entry) => entry.replace(/^room:/i, ""),
    });

    expect(entries).toEqual([
      { kind: "group", id: "a" },
      { kind: "group", id: "b" },
    ]);
  });

  it("lists entries from resolved account sources", () => {
    const entries = listResolvedDirectoryEntriesFromSources({
      cfg,
      kind: "user",
      resolveAccount,
      resolveSources: (account) => [account.allowFrom, ["user:carla", "user:alice"]],
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
      limit: 2,
    });

    expectUserDirectoryEntries(entries);
  });

  it("builds a reusable resolved-account lister", async () => {
    const listUsers = createResolvedDirectoryEntriesLister({
      kind: "user",
      resolveAccount,
      resolveSources: (account) => [account.allowFrom, ["user:carla", "user:alice"]],
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
    });

    await expect(listUsers({ cfg, query: "a", limit: 2 })).resolves.toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });
});
