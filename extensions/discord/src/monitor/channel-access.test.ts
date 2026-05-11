import { describe, expect, it } from "vitest";
import {
  resolveDiscordChannelInfoSafe,
  resolveDiscordChannelOwnerIdSafe,
  resolveDiscordChannelParentIdSafe,
} from "./channel-access.js";

describe("resolveDiscordChannelOwnerIdSafe", () => {
  it("reads camelCase ownerId directly", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ ownerId: "owner-1" })).toBe("owner-1");
  });

  it("falls back to direct snake_case owner_id", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ owner_id: "owner-2" })).toBe("owner-2");
  });

  it("falls back to rawData owner_id when direct fields are missing", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ rawData: { owner_id: "owner-3" } })).toBe("owner-3");
  });

  it("prefers camelCase and direct snake_case before rawData", () => {
    expect(
      resolveDiscordChannelOwnerIdSafe({
        ownerId: "camel",
        owner_id: "snake",
        rawData: { owner_id: "raw" },
      }),
    ).toBe("camel");
    expect(
      resolveDiscordChannelOwnerIdSafe({
        owner_id: "snake",
        rawData: { owner_id: "raw" },
      }),
    ).toBe("snake");
  });

  it("ignores invalid values and unsafe accessors", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ ownerId: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ owner_id: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ rawData: { owner_id: 123 } })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe(null)).toBeUndefined();
    expect(
      resolveDiscordChannelOwnerIdSafe(
        new Proxy(
          {},
          {
            get() {
              throw new Error("boom");
            },
            has() {
              throw new Error("boom");
            },
          },
        ),
      ),
    ).toBeUndefined();
  });
});

describe("resolveDiscordChannelParentIdSafe", () => {
  it("reads parentId from camelCase, direct snake_case, and rawData", () => {
    expect(resolveDiscordChannelParentIdSafe({ parentId: "parent-1" })).toBe("parent-1");
    expect(resolveDiscordChannelParentIdSafe({ parent_id: "parent-2" })).toBe("parent-2");
    expect(resolveDiscordChannelParentIdSafe({ rawData: { parent_id: "parent-3" } })).toBe(
      "parent-3",
    );
  });

  it("prefers camelCase over snake_case and rawData", () => {
    expect(
      resolveDiscordChannelParentIdSafe({
        parentId: "camel",
        parent_id: "snake",
        rawData: { parent_id: "raw" },
      }),
    ).toBe("camel");
  });

  it("ignores invalid fallback values", () => {
    expect(resolveDiscordChannelParentIdSafe({ parent_id: 7 })).toBeUndefined();
    expect(resolveDiscordChannelParentIdSafe({ rawData: { parent_id: 7 } })).toBeUndefined();
  });
});

describe("resolveDiscordChannelInfoSafe", () => {
  it("populates ownerId and parentId from Discord API-style snake_case fields", () => {
    expect(
      resolveDiscordChannelInfoSafe({
        owner_id: "owner-snake",
        parent_id: "parent-snake",
      }),
    ).toEqual({
      name: undefined,
      topic: undefined,
      type: undefined,
      parentId: "parent-snake",
      ownerId: "owner-snake",
      parentName: undefined,
    });
    expect(
      resolveDiscordChannelInfoSafe({
        rawData: { owner_id: "owner-raw", parent_id: "parent-raw" },
      }),
    ).toEqual({
      name: undefined,
      topic: undefined,
      type: undefined,
      parentId: "parent-raw",
      ownerId: "owner-raw",
      parentName: undefined,
    });
  });
});
