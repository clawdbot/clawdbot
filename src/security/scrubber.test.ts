import { describe, expect, it } from "vitest";
import { SecretScrubber } from "./scrubber.js";

describe("SecretScrubber", () => {
  describe("Heuristics", () => {
    it("identifies secrets with suffix matching", () => {
      const scrubber = new SecretScrubber();
      scrubber.extractFromConfig({
        my_api_key: "sensitive-key-123",
        db_password: "sensitive-password-123",
        keyboard_layout: "not-sensitive-123", // false positive if using includes
        monkey_patch: "not-sensitive-456", // false positive if using includes
      });

      const text =
        "Key: sensitive-key-123, Pass: sensitive-password-123, Layout: not-sensitive-123";
      const scrubbed = scrubber.scrub(text);

      expect(scrubbed).toContain("Key: your-key-here");
      expect(scrubbed).toContain("Pass: your-key-here");
      expect(scrubbed).toContain("Layout: not-sensitive-123");
    });

    it("identifies common camelCase sensitive keys", () => {
      const scrubber = new SecretScrubber();
      scrubber.extractFromConfig({
        apiKey: "sensitive-api-key",
        authToken: "sensitive-auth-token",
      });

      const text = "api: sensitive-api-key, token: sensitive-auth-token";
      const scrubbed = scrubber.scrub(text);

      expect(scrubbed).toBe("api: your-key-here, token: your-key-here");
    });
  });

  describe("Stability", () => {
    it("handles circular references gracefully", () => {
      const scrubber = new SecretScrubber();
      const config: any = { api_key: "secret-circular" };
      config.self = config;

      expect(() => scrubber.extractFromConfig(config)).not.toThrow();
      expect(scrubber.scrub("secret-circular")).toBe("your-key-here");
    });

    it("escapes regex special characters in secrets", () => {
      const scrubber = new SecretScrubber(["$ecret.with*chars+"]);
      const text = "My secret is $ecret.with*chars+ now.";
      expect(scrubber.scrub(text)).toBe("My secret is your-key-here now.");
    });

    it("handles overlapping secrets by redacting longer ones first", () => {
      const scrubber = new SecretScrubber(["password", "password123"]);
      const text = "My pass is password123";
      // If "password" matched first, result would be "your-key-here123"
      expect(scrubber.scrub(text)).toBe("My pass is your-key-here");
    });
  });

  describe("Performance & Limits", () => {
    it("ignores secrets that are too short", () => {
      const scrubber = new SecretScrubber(["short"]);
      expect(scrubber.scrub("short")).toBe("short");
    });

    it("ignores secrets that are too long", () => {
      const longSecret = "a".repeat(5000);
      const scrubber = new SecretScrubber([longSecret]);
      expect(scrubber.scrub(longSecret)).toBe(longSecret);
    });
  });
});
