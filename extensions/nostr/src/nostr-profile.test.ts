// Nostr tests cover nostr profile plugin behavior.
import { verifyEvent, getPublicKey, type Event, type SimplePool } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import { contentToProfile, profileToContent, type ProfileContent } from "./nostr-profile-core.js";
import { publishProfile } from "./nostr-profile.js";
import { TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";

const TEST_PUBKEY = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);

async function publishTestProfile(profile: NostrProfile, lastPublishedAt?: number): Promise<Event> {
  let publishedEvent: Event | undefined;
  const pool = {
    publish: vi.fn((_relays: string[], event: Event) => {
      publishedEvent = event;
      return [Promise.resolve()];
    }),
  } as unknown as SimplePool;

  await publishProfile(
    pool,
    TEST_HEX_PRIVATE_KEY_BYTES,
    ["wss://relay.example"],
    profile,
    lastPublishedAt,
  );

  if (!publishedEvent) {
    throw new Error("expected profile event to be published");
  }
  return publishedEvent;
}

// ============================================================================
// Profile Content Conversion Tests
// ============================================================================

describe("profileToContent", () => {
  it("converts full profile to NIP-01 content format", () => {
    const profile: NostrProfile = {
      name: "testuser",
      displayName: "Test User",
      about: "A test user for unit testing",
      picture: "https://example.com/avatar.png",
      banner: "https://example.com/banner.png",
      website: "https://example.com",
      nip05: "testuser@example.com",
      lud16: "testuser@walletofsatoshi.com",
    };

    const content = profileToContent(profile);

    expect(content.name).toBe("testuser");
    expect(content.display_name).toBe("Test User");
    expect(content.about).toBe("A test user for unit testing");
    expect(content.picture).toBe("https://example.com/avatar.png");
    expect(content.banner).toBe("https://example.com/banner.png");
    expect(content.website).toBe("https://example.com");
    expect(content.nip05).toBe("testuser@example.com");
    expect(content.lud16).toBe("testuser@walletofsatoshi.com");
  });

  it("omits undefined fields from content", () => {
    const profile: NostrProfile = {
      name: "minimaluser",
    };

    const content = profileToContent(profile);

    expect(content.name).toBe("minimaluser");
    expect("display_name" in content).toBe(false);
    expect("about" in content).toBe(false);
    expect("picture" in content).toBe(false);
  });

  it("handles empty profile", () => {
    const profile: NostrProfile = {};
    const content = profileToContent(profile);
    expect(Object.keys(content)).toHaveLength(0);
  });

  it("rejects invalid URLs", () => {
    expect(() =>
      profileToContent({
        picture: "http://insecure.example.com/pic.png",
      }),
    ).toThrow("URL must use https:// protocol");
  });

  it("rejects oversized fields", () => {
    expect(() => profileToContent({ name: "a".repeat(257) })).toThrow();
    expect(() => profileToContent({ about: "a".repeat(2001) })).toThrow();
  });
});

describe("contentToProfile", () => {
  it("converts NIP-01 content to profile format", () => {
    const content: ProfileContent = {
      name: "testuser",
      display_name: "Test User",
      about: "A test user",
      picture: "https://example.com/avatar.png",
      nip05: "test@example.com",
    };

    const profile = contentToProfile(content);

    expect(profile.name).toBe("testuser");
    expect(profile.displayName).toBe("Test User");
    expect(profile.about).toBe("A test user");
    expect(profile.picture).toBe("https://example.com/avatar.png");
    expect(profile.nip05).toBe("test@example.com");
  });

  it("handles empty content", () => {
    const content: ProfileContent = {};
    const profile = contentToProfile(content);
    expect(
      Object.keys(profile).filter((k) => profile[k as keyof NostrProfile] !== undefined),
    ).toHaveLength(0);
  });

  it("round-trips profile data", () => {
    const original: NostrProfile = {
      name: "roundtrip",
      displayName: "Round Trip Test",
      about: "Testing round-trip conversion",
    };

    const content = profileToContent(original);
    const restored = contentToProfile(content);

    expect(restored.name).toBe(original.name);
    expect(restored.displayName).toBe(original.displayName);
    expect(restored.about).toBe(original.about);
  });
});

// ============================================================================
// Event Creation Tests
// ============================================================================

describe("createProfileEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a valid kind:0 event", async () => {
    const profile: NostrProfile = {
      name: "testbot",
      about: "A test bot",
    };

    const event = await publishTestProfile(profile);

    expect(event.kind).toBe(0);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(event.tags).toStrictEqual([]);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it("includes profile content as JSON in event content", async () => {
    const profile: NostrProfile = {
      name: "jsontest",
      displayName: "JSON Test User",
      about: "Testing JSON serialization",
    };

    const event = await publishTestProfile(profile);
    const parsedContent = JSON.parse(event.content) as ProfileContent;

    expect(parsedContent.name).toBe("jsontest");
    expect(parsedContent.display_name).toBe("JSON Test User");
    expect(parsedContent.about).toBe("Testing JSON serialization");
  });

  it("produces a verifiable signature", async () => {
    const profile: NostrProfile = { name: "signaturetest" };
    const event = await publishTestProfile(profile);

    expect(verifyEvent(event)).toBe(true);
  });

  it("uses current timestamp when no lastPublishedAt provided", async () => {
    const profile: NostrProfile = { name: "timestamptest" };
    const event = await publishTestProfile(profile);

    const expectedTimestamp = Math.floor(Date.now() / 1000);
    expect(event.created_at).toBe(expectedTimestamp);
  });

  it("ensures monotonic timestamp when lastPublishedAt is in the future", async () => {
    // Current time is 2024-01-15T12:00:00Z = 1705320000
    const futureTimestamp = 1705320000 + 3600; // 1 hour in the future
    const profile: NostrProfile = { name: "monotonictest" };

    const event = await publishTestProfile(profile, futureTimestamp);

    expect(event.created_at).toBe(futureTimestamp + 1);
  });

  it("uses current time when lastPublishedAt is in the past", async () => {
    const pastTimestamp = 1705320000 - 3600; // 1 hour in the past
    const profile: NostrProfile = { name: "pasttest" };

    const event = await publishTestProfile(profile, pastTimestamp);

    const expectedTimestamp = Math.floor(Date.now() / 1000);
    expect(event.created_at).toBe(expectedTimestamp);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("handles emoji in profile fields", async () => {
    const profile: NostrProfile = {
      name: "🤖 Bot",
      about: "I am a 🤖 robot! 🎉",
    };

    const content = profileToContent(profile);
    expect(content.name).toBe("🤖 Bot");
    expect(content.about).toBe("I am a 🤖 robot! 🎉");

    const event = await publishTestProfile(profile);
    const parsed = JSON.parse(event.content) as ProfileContent;
    expect(parsed.name).toBe("🤖 Bot");
  });

  it("handles unicode in profile fields", async () => {
    const profile: NostrProfile = {
      name: "日本語ユーザー",
      about: "Привет мир! 你好世界!",
    };

    const content = profileToContent(profile);
    expect(content.name).toBe("日本語ユーザー");

    const event = await publishTestProfile(profile);
    expect(verifyEvent(event)).toBe(true);
  });

  it("handles newlines in about field", async () => {
    const profile: NostrProfile = {
      about: "Line 1\nLine 2\nLine 3",
    };

    const content = profileToContent(profile);
    expect(content.about).toBe("Line 1\nLine 2\nLine 3");

    const event = await publishTestProfile(profile);
    const parsed = JSON.parse(event.content) as ProfileContent;
    expect(parsed.about).toBe("Line 1\nLine 2\nLine 3");
  });

  it("handles maximum length fields", async () => {
    const profile: NostrProfile = {
      name: "a".repeat(256),
      about: "b".repeat(2000),
    };

    expect(profileToContent(profile)).toEqual({
      name: profile.name,
      about: profile.about,
    });
    const event = await publishTestProfile(profile);
    expect(verifyEvent(event)).toBe(true);
  });
});

// ============================================================================
// Profile Publishing Tests
// ============================================================================

describe("publishProfile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createFakePool(publishResult: unknown): SimplePool {
    return {
      publish: vi.fn(() => [publishResult]),
    } as unknown as SimplePool;
  }

  it("clears the per-relay timeout timer after a successful publish", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const profile: NostrProfile = { name: "test" };
    const pool = createFakePool(Promise.resolve());

    const result = await publishProfile(
      pool,
      TEST_HEX_PRIVATE_KEY_BYTES,
      ["wss://relay.example"],
      profile,
    );

    expect(result.successes).toEqual(["wss://relay.example"]);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the per-relay timeout timer after a publish timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const profile: NostrProfile = { name: "test" };
    const pool = createFakePool(new Promise(() => {}));

    const promise = publishProfile(
      pool,
      TEST_HEX_PRIVATE_KEY_BYTES,
      ["wss://relay.example"],
      profile,
    );
    vi.advanceTimersByTime(6_000);
    const result = await promise;

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain("timeout");
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("does not add dangling timers when publishing to multiple relays", async () => {
    vi.spyOn(globalThis, "setTimeout").mockClear();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const profile: NostrProfile = { name: "test" };
    const pool = createFakePool(Promise.resolve());

    await publishProfile(
      pool,
      TEST_HEX_PRIVATE_KEY_BYTES,
      ["wss://relay.a", "wss://relay.b"],
      profile,
    );

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });
});
