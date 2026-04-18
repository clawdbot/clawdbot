import { describe, expect, it } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import {
  profileToContent,
  sanitizeProfileForDisplay,
  validateProfile,
} from "./nostr-profile-core.js";

// ============================================================================
// Unicode Attack Vectors
// ============================================================================

describe("profile unicode attacks", () => {
  describe("zero-width characters", () => {
    it("handles zero-width space in name", () => {
      const profile: NostrProfile = {
        name: "test\u200Buser", // Zero-width space
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
      // The character should be preserved (not stripped)
      expect(result.profile?.name).toBe("test\u200Buser");
    });

    it("handles zero-width joiner in name", () => {
      const profile: NostrProfile = {
        name: "test\u200Duser", // Zero-width joiner
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles zero-width non-joiner in about", () => {
      const profile: NostrProfile = {
        about: "test\u200Cabout", // Zero-width non-joiner
      };
      const content = profileToContent(profile);
      expect(content.about).toBe("test\u200Cabout");
    });
  });

  describe("RTL override attacks", () => {
    it("handles RTL override in name", () => {
      const profile: NostrProfile = {
        name: "\u202Eevil\u202C", // Right-to-left override + pop direction
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
      expect(result.profile).toBeDefined();
      if (!result.profile) {
        throw new Error("expected validated profile");
      }

      // UI should escape or handle this
      const sanitized = sanitizeProfileForDisplay(result.profile);
      expect(sanitized.name).toBeDefined();
    });

    it("handles bidi embedding in about", () => {
      const profile: NostrProfile = {
        about: "Normal \u202Breversed\u202C text", // LTR embedding
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });

  describe("homoglyph attacks", () => {
    it("handles Cyrillic homoglyphs", () => {
      const profile: NostrProfile = {
        // Cyrillic 'а' (U+0430) looks like Latin 'a'
        name: "\u0430dmin", // Fake "admin"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
      // Profile is accepted but apps should be aware
    });

    it("handles Greek homoglyphs", () => {
      const profile: NostrProfile = {
        // Greek 'ο' (U+03BF) looks like Latin 'o'
        name: "b\u03BFt", // Looks like "bot"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });

  describe("combining characters", () => {
    it("handles combining diacritics", () => {
      const profile: NostrProfile = {
        name: "cafe\u0301", // 'e' + combining acute = 'é'
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
      expect(result.profile?.name).toBe("cafe\u0301");
    });

    it("handles excessive combining characters (Zalgo text)", () => {
      // Keep the source small (faster transforms) while still exercising
      // "lots of combining marks" behavior.
      const marks = "\u0301\u0300\u0336\u034f\u035c\u0360";
      const zalgo = `t${marks.repeat(256)}e${marks.repeat(256)}s${marks.repeat(256)}t`;
      const profile: NostrProfile = {
        name: zalgo.slice(0, 256), // Truncate to fit limit
      };
      const result = validateProfile(profile);
      // Should be valid but may look weird
      expect(result.valid).toBe(true);
    });
  });

  describe("CJK and other scripts", () => {
    it("handles Chinese characters", () => {
      const profile: NostrProfile = {
        name: "中文用户",
        about: "我是一个机器人",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles Japanese hiragana and katakana", () => {
      const profile: NostrProfile = {
        name: "ボット",
        about: "これはテストです",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles Korean characters", () => {
      const profile: NostrProfile = {
        name: "한국어사용자",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles Arabic text", () => {
      const profile: NostrProfile = {
        name: "مستخدم",
        about: "مرحبا بالعالم",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles Hebrew text", () => {
      const profile: NostrProfile = {
        name: "משתמש",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles Thai text", () => {
      const profile: NostrProfile = {
        name: "ผู้ใช้",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });

  describe("emoji edge cases", () => {
    it("handles emoji sequences (ZWJ)", () => {
      const profile: NostrProfile = {
        name: "👨‍👩‍👧‍👦", // Family emoji using ZWJ
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles flag emojis", () => {
      const profile: NostrProfile = {
        name: "🇺🇸🇯🇵🇬🇧",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });

    it("handles skin tone modifiers", () => {
      const profile: NostrProfile = {
        name: "👋🏻👋🏽👋🏿",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });
});

// ============================================================================
// XSS Attack Vectors
// ============================================================================

describe("profile XSS attacks", () => {
  describe("script injection", () => {
    it("escapes script tags", () => {
      const profile: NostrProfile = {
        name: '<script>alert("xss")</script>',
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.name).not.toContain("<script>");
      expect(sanitized.name).toContain("&lt;script&gt;");
    });

    it("escapes nested script tags", () => {
      const profile: NostrProfile = {
        about: '<<script>script>alert("xss")<</script>/script>',
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).not.toContain("<script>");
    });
  });

  describe("event handler injection", () => {
    it("escapes img onerror", () => {
      const profile: NostrProfile = {
        about: '<img src="x" onerror="alert(1)">',
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;img");
      expect(sanitized.about).not.toContain('onerror="alert');
    });

    it("escapes svg onload", () => {
      const profile: NostrProfile = {
        about: '<svg onload="alert(1)">',
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;svg");
    });

    it("escapes body onload", () => {
      const profile: NostrProfile = {
        about: '<body onload="alert(1)">',
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;body");
    });
  });

  describe("URL-based attacks", () => {
    it("rejects javascript: URL in picture", () => {
      const profile = {
        picture: "javascript:alert('xss')",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });

    it("rejects javascript: URL with encoding", () => {
      const profile = {
        picture: "java&#115;cript:alert('xss')",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });

    it("rejects data: URL", () => {
      const profile = {
        picture: "data:text/html,<script>alert('xss')</script>",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });

    it("rejects vbscript: URL", () => {
      const profile = {
        website: "vbscript:msgbox('xss')",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });

    it("rejects file: URL", () => {
      const profile = {
        picture: "file:///etc/passwd",
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });
  });

  describe("HTML attribute injection", () => {
    it("escapes double quotes in fields", () => {
      const profile: NostrProfile = {
        name: '" onclick="alert(1)" data-x="',
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.name).toContain("&quot;");
      expect(sanitized.name).not.toContain('onclick="alert');
    });

    it("escapes single quotes in fields", () => {
      const profile: NostrProfile = {
        name: "' onclick='alert(1)' data-x='",
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.name).toContain("&#039;");
    });
  });

  describe("CSS injection", () => {
    it("escapes style tags", () => {
      const profile: NostrProfile = {
        about: '<style>body{background:url("javascript:alert(1)")}</style>',
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;style&gt;");
    });
  });
});

// ============================================================================
// Length Boundary Tests
// ============================================================================

describe("profile length boundaries", () => {
  describe("name field (max 256)", () => {
    it("accepts exactly 256 characters", () => {
      const result = validateProfile({ name: "a".repeat(256) });
      expect(result.valid).toBe(true);
    });

    it("rejects 257 characters", () => {
      const result = validateProfile({ name: "a".repeat(257) });
      expect(result.valid).toBe(false);
    });

    it("accepts empty string", () => {
      const result = validateProfile({ name: "" });
      expect(result.valid).toBe(true);
    });
  });

  describe("displayName field (max 256)", () => {
    it("accepts exactly 256 characters", () => {
      const result = validateProfile({ displayName: "b".repeat(256) });
      expect(result.valid).toBe(true);
    });

    it("rejects 257 characters", () => {
      const result = validateProfile({ displayName: "b".repeat(257) });
      expect(result.valid).toBe(false);
    });
  });

  describe("about field (max 2000)", () => {
    it("accepts exactly 2000 characters", () => {
      const result = validateProfile({ about: "c".repeat(2000) });
      expect(result.valid).toBe(true);
    });

    it("rejects 2001 characters", () => {
      const result = validateProfile({ about: "c".repeat(2001) });
      expect(result.valid).toBe(false);
    });
  });

  describe("URL fields", () => {
    it("accepts long valid HTTPS URLs", () => {
      const longPath = "a".repeat(1000);
      const result = validateProfile({
        picture: `https://example.com/${longPath}.png`,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid URL format", () => {
      const result = validateProfile({
        picture: "not-a-url",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects URL without protocol", () => {
      const result = validateProfile({
        picture: "example.com/pic.png",
      });
      expect(result.valid).toBe(false);
    });
  });
});

// ============================================================================
// Type Confusion Tests
// ============================================================================

describe("profile type confusion", () => {
  it("rejects number as name", () => {
    const result = validateProfile({ name: 123 as unknown as string });
    expect(result.valid).toBe(false);
  });

  it("rejects array as about", () => {
    const result = validateProfile({ about: ["hello"] as unknown as string });
    expect(result.valid).toBe(false);
  });

  it("rejects object as picture", () => {
    const result = validateProfile({
      picture: { url: "https://example.com" } as unknown as string,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects null as name", () => {
    const result = validateProfile({ name: null as unknown as string });
    expect(result.valid).toBe(false);
  });

  it("rejects boolean as about", () => {
    const result = validateProfile({ about: true as unknown as string });
    expect(result.valid).toBe(false);
  });

  it("rejects function as name", () => {
    const result = validateProfile({ name: (() => "test") as unknown as string });
    expect(result.valid).toBe(false);
  });

  it("handles prototype pollution attempt", () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    validateProfile(malicious);
    // Should not pollute Object.prototype
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
