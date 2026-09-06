// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  readPresenceEntries,
  resolveCurrentSelfUser,
  resolveSelfPresenceUser,
} from "./user-profile.ts";

describe("connection user profile helpers", () => {
  it("resolves identity only from the current live presence entry", () => {
    const entries = [
      { instanceId: "other", user: { id: "other-profile", name: "Other" }, ts: 1 },
      { instanceId: "self", user: { id: "old", name: "Old" }, reason: "disconnect", ts: 2 },
      { instanceId: "self", user: { id: "profile-1", name: "Ada" }, ts: 3 },
    ];

    expect(resolveSelfPresenceUser(entries, "self")).toEqual({ id: "profile-1", name: "Ada" });
    expect(resolveSelfPresenceUser(entries, "anonymous")).toBeNull();
    expect(resolveSelfPresenceUser(entries, undefined)).toBeNull();
  });

  it("prefers locally refreshed identity state over the presence snapshot", () => {
    const presenceEntries = [{ instanceId: "self", user: { id: "profile-1", name: "Ada" }, ts: 1 }];

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
  });

  it("reads presence payloads", () => {
    const entries = [{ instanceId: "self", user: { id: "profile/1" }, ts: 1 }];
    expect(readPresenceEntries({ presence: entries })).toEqual(entries);
    expect(readPresenceEntries({ presence: null })).toBeUndefined();
  });
});
