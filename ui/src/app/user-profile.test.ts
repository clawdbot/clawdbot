import { describe, expect, it } from "vitest";
import {
  readPresenceEntries,
  resolveCurrentSelfUser,
  resolveSelfPresenceUser,
  userProfileAvatarUrl,
} from "./user-profile.ts";

describe("connection user profile helpers", () => {
  it("resolves identity only from the current live presence entry", () => {
    const entries = [
      { instanceId: "other", user: { id: "other-profile", name: "Other" } },
      { instanceId: "self", user: { id: "old", name: "Old" }, reason: "disconnect" },
      { instanceId: "self", user: { id: "profile-1", name: "Ada" } },
    ];

    expect(resolveSelfPresenceUser(entries, "self")).toEqual({ id: "profile-1", name: "Ada" });
    expect(resolveSelfPresenceUser(entries, "anonymous")).toBeNull();
    expect(resolveSelfPresenceUser(entries, undefined)).toBeNull();
  });

  it("prefers locally refreshed identity state over the presence snapshot", () => {
    const presenceEntries = [{ instanceId: "self", user: { id: "profile-1", name: "Ada" } }];

    expect(
      resolveCurrentSelfUser({
        snapshotUser: { id: "profile-1", name: "Augusta Ada" },
        presenceEntries,
        presenceInstanceId: "self",
      }),
    ).toEqual({ id: "profile-1", name: "Augusta Ada" });
    expect(resolveCurrentSelfUser({ presenceEntries, presenceInstanceId: "self" })).toEqual({
      id: "profile-1",
      name: "Ada",
    });
    expect(
      resolveCurrentSelfUser({
        snapshotUser: { id: "previous-profile", name: "Previous User" },
        presenceEntries,
        presenceInstanceId: "self",
      }),
    ).toEqual({ id: "profile-1", name: "Ada" });
  });

  it("reads presence payloads and builds scoped cache-busted avatar URLs", () => {
    const entries = [{ instanceId: "self", user: { id: "profile/1" } }];
    expect(readPresenceEntries({ presence: entries })).toEqual(entries);
    expect(readPresenceEntries({ presence: null })).toBeUndefined();
    expect(
      userProfileAvatarUrl(
        "wss://gateway.example.test/control",
        "profile/1",
        42,
        "https://gateway.example.test/control/profile",
      ),
    ).toBe("https://gateway.example.test/api/users/profile%2F1/avatar?v=42");
    expect(
      userProfileAvatarUrl(
        "wss://remote.example.test",
        "profile-1",
        42,
        "https://gateway.example.test/control/profile",
      ),
    ).toBeNull();
  });
});
