import { verifyEvent, getPublicKey } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import {
  createProfileEvent,
  profileToContent,
  contentToProfile,
  validateProfile,
  sanitizeProfileForDisplay,
  type ProfileContent,
} from "./nostr-profile.js";
import { TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";

const TEST_PUBKEY = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);

function createTestProfileEvent(profile: NostrProfile, lastPublishedAt?: number) {
  return createProfileEvent(TEST_HEX_PRIVATE_KEY_BYTES, profile, lastPublishedAt);
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

  it("creates a valid kind:0 event", () => {
    const profile: NostrProfile = {
      name: "testbot",
      about: "A test bot",
    };

    const event = createTestProfileEvent(profile);

    expect(event.kind).toBe(0);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(event.tags).toEqual([]);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it("includes profile content as JSON in event content", () => {
    const profile: NostrProfile = {
      name: "jsontest",
      displayName: "JSON Test User",
      about: "Testing JSON serialization",
    };

    const event = createTestProfileEvent(profile);
    const parsedContent = JSON.parse(event.content) as ProfileContent;

    expect(parsedContent.name).toBe("jsontest");
    expect(parsedContent.display_name).toBe("JSON Test User");
    expect(parsedContent.about).toBe("Testing JSON serialization");
  });

  it("produces a verifiable signature", () => {
    const profile: NostrProfile = { name: "signaturetest" };
    const event = createTestProfileEvent(profile);

    expect(verifyEvent(event)).toBe(true);
  });

  it("uses current timestamp when no lastPublishedAt provided", () => {
    const profile: NostrProfile = { name: "timestamptest" };
    const event = createTestProfileEvent(profile);

    const expectedTimestamp = Math.floor(Date.now() / 1000);
    expect(event.created_at).toBe(expectedTimestamp);
  });

  it("ensures monotonic timestamp when lastPublishedAt is in the future", () => {
    // Current time is 2024-01-15T12:00:00Z = 1705320000
    const futureTimestamp = 1705320000 + 3600; // 1 hour in the future
    const profile: NostrProfile = { name: "monotonictest" };

    const event = createTestProfileEvent(profile, futureTimestamp);

    expect(event.created_at).toBe(futureTimestamp + 1);
  });

  it("uses current time when lastPublishedAt is in the past", () => {
    const pastTimestamp = 1705320000 - 3600; // 1 hour in the past
    const profile: NostrProfile = { name: "pasttest" };

    const event = createTestProfileEvent(profile, pastTimestamp);

    const expectedTimestamp = Math.floor(Date.now() / 1000);
    expect(event.created_at).toBe(expectedTimestamp);
  });
});

// ============================================================================
// Profile Validation Tests
// ============================================================================

describe("validateProfile", () => {
  it("validates a correct profile", () => {
    const profile = {
      name: "validuser",
      about: "A valid user",
      picture: "https://example.com/pic.png",
    };

    const result = validateProfile(profile);

    expect(result.valid).toBe(true);
    expect(result.profile).toBeDefined();
    expect(result.errors).toBeUndefined();
  });

  it("rejects profile with invalid URL", () => {
    const profile = {
      name: "invalidurl",
      picture: "http://insecure.example.com/pic.png", // HTTP not HTTPS
    };

    const result = validateProfile(profile);

    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes("https://"))).toBe(true);
  });

  it("rejects profile with javascript: URL", () => {
    const profile = {
      name: "xssattempt",
      picture: "javascript:alert('xss')",
    };

    const result = validateProfile(profile);

    expect(result.valid).toBe(false);
  });

  it("rejects profile with data: URL", () => {
    const profile = {
      name: "dataurl",
      picture: "data:image/png;base64,abc123",
    };

    const result = validateProfile(profile);

    expect(result.valid).toBe(false);
  });

  it("rejects name exceeding 256 characters", () => {
    const profile = {
      name: "a".repeat(257),
    };

    const result = validateProfile(profile);

    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes("256"))).toBe(true);
  });

  it("rejects about exceeding 2000 characters", () => {
    const profile = {
      about: "a".repeat(2001),
    };

    const result = validateProfile(profile);

    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes("2000"))).toBe(true);
  });

  it("accepts empty profile", () => {
    const result = validateProfile({});
    expect(result.valid).toBe(true);
  });

  it("rejects null input", () => {
    const result = validateProfile(null);
    expect(result.valid).toBe(false);
  });

  it("rejects non-object input", () => {
    const result = validateProfile("not an object");
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Sanitization Tests
// ============================================================================

describe("sanitizeProfileForDisplay", () => {
  it("escapes HTML in name field", () => {
    const profile: NostrProfile = {
      name: "<script>alert('xss')</script>",
    };

    const sanitized = sanitizeProfileForDisplay(profile);

    expect(sanitized.name).toBe("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");
  });

  it("escapes HTML in about field", () => {
    const profile: NostrProfile = {
      about: 'Check out <img src="x" onerror="alert(1)">',
    };

    const sanitized = sanitizeProfileForDisplay(profile);

    expect(sanitized.about).toBe(
      "Check out &lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("preserves URLs without modification", () => {
    const profile: NostrProfile = {
      picture: "https://example.com/pic.png",
      website: "https://example.com",
    };

    const sanitized = sanitizeProfileForDisplay(profile);

    expect(sanitized.picture).toBe("https://example.com/pic.png");
    expect(sanitized.website).toBe("https://example.com");
  });

  it("handles undefined fields", () => {
    const profile: NostrProfile = {
      name: "test",
    };

    const sanitized = sanitizeProfileForDisplay(profile);

    expect(sanitized.name).toBe("test");
    expect(sanitized.about).toBeUndefined();
    expect(sanitized.picture).toBeUndefined();
  });

  it("escapes ampersands", () => {
    const profile: NostrProfile = {
      name: "Tom & Jerry",
    };

    const sanitized = sanitizeProfileForDisplay(profile);

    expect(sanitized.name).toBe("Tom &amp; Jerry");
  });

  it("escapes quotes", () => {
    const profile: NostrProfile = {
      about: 'Say "hello" to everyone',
    };

    const sanitized = sanitizeProfileForDisplay(profile);

    expect(sanitized.about).toBe("Say &quot;hello&quot; to everyone");
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("handles emoji in profile fields", () => {
    const profile: NostrProfile = {
      name: "🤖 Bot",
      about: "I am a 🤖 robot! 🎉",
    };

    const content = profileToContent(profile);
    expect(content.name).toBe("🤖 Bot");
    expect(content.about).toBe("I am a 🤖 robot! 🎉");

    const event = createTestProfileEvent(profile);
    const parsed = JSON.parse(event.content) as ProfileContent;
    expect(parsed.name).toBe("🤖 Bot");
  });

  it("handles unicode in profile fields", () => {
    const profile: NostrProfile = {
      name: "日本語ユーザー",
      about: "Привет мир! 你好世界!",
    };

    const content = profileToContent(profile);
    expect(content.name).toBe("日本語ユーザー");

    const event = createTestProfileEvent(profile);
    expect(verifyEvent(event)).toBe(true);
  });

  it("handles newlines in about field", () => {
    const profile: NostrProfile = {
      about: "Line 1\nLine 2\nLine 3",
    };

    const content = profileToContent(profile);
    expect(content.about).toBe("Line 1\nLine 2\nLine 3");

    const event = createTestProfileEvent(profile);
    const parsed = JSON.parse(event.content) as ProfileContent;
    expect(parsed.about).toBe("Line 1\nLine 2\nLine 3");
  });

  it("handles maximum length fields", () => {
    const profile: NostrProfile = {
      name: "a".repeat(256),
      about: "b".repeat(2000),
    };

    const result = validateProfile(profile);
    expect(result.valid).toBe(true);

    const event = createTestProfileEvent(profile);
    expect(verifyEvent(event)).toBe(true);
  });
});
