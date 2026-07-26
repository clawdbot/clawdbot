import { describe, expect, it } from "vitest";
import { DiscordPresenceBaselineCache } from "./presence-transition-cache.js";

describe("DiscordPresenceBaselineCache", () => {
  it("bounds each status while protecting offline markers from online churn", () => {
    const cache = new DiscordPresenceBaselineCache(2);

    expect(cache.observeOffline("guild", "oldest")).toBeUndefined();
    expect(cache.observeOnline("guild", "online-1")).toBeUndefined();
    expect(cache.observeOnline("guild", "online-2")).toBeUndefined();
    expect(cache.observeOnline("guild", "online-3")).toBe("guild");

    expect(cache.isOffline("guild", "oldest")).toBe(true);
    expect(cache.isOnline("guild", "online-1")).toBe(false);
    expect(cache.isOnline("guild", "online-2")).toBe(true);
    expect(cache.isOnline("guild", "online-3")).toBe(true);
  });

  it("moves a member between mutually exclusive status markers", () => {
    const cache = new DiscordPresenceBaselineCache(2);

    cache.observeOffline("guild", "member");
    cache.observeOnline("guild", "member");
    expect(cache.isOffline("guild", "member")).toBe(false);
    expect(cache.isOnline("guild", "member")).toBe(true);

    cache.observeOffline("guild", "member");
    expect(cache.isOffline("guild", "member")).toBe(true);
    expect(cache.isOnline("guild", "member")).toBe(false);
  });

  it("clears every marker for a new gateway session", () => {
    const cache = new DiscordPresenceBaselineCache(2);
    cache.observeOffline("guild", "member");
    cache.observeOnline("guild", "online-member");

    cache.clear();

    expect(cache.isOffline("guild", "member")).toBe(false);
    expect(cache.isOnline("guild", "online-member")).toBe(false);
  });

  it("replaces only one guild scope", () => {
    const cache = new DiscordPresenceBaselineCache(3);
    cache.observeOnline("guild-a", "member");
    cache.observeOnline("guild-b", "member");

    cache.clearScope("guild-a");

    expect(cache.isOnline("guild-a", "member")).toBe(false);
    expect(cache.isOnline("guild-b", "member")).toBe(true);
  });

  it("bounds aggregate entries and reports the affected guild", () => {
    const cache = new DiscordPresenceBaselineCache(1);

    cache.observeOnline("busy", "old");
    expect(cache.observeOnline("quiet", "member")).toBe("busy");

    expect(cache.isOnline("quiet", "member")).toBe(true);
    expect(cache.isOnline("busy", "old")).toBe(false);
  });
});
