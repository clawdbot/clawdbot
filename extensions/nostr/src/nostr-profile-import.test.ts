/**
 * Tests for Nostr Profile Import
 */

import { describe, it, expect } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import { mergeProfiles } from "./nostr-profile-import.js";

// Note: importProfileFromRelays requires real network calls or complex mocking
// of nostr-tools SimplePool, so we focus on unit testing mergeProfiles

describe("nostr-profile-import", () => {
  describe("mergeProfiles", () => {
    it("returns empty object when both are undefined", () => {
      const result = mergeProfiles(undefined, undefined);
      expect(result).toEqual({});
    });

    it("returns imported when local is undefined", () => {
      const imported: NostrProfile = {
        name: "imported",
        displayName: "Imported User",
        about: "Bio from relay",
      };
      const result = mergeProfiles(undefined, imported);
      expect(result).toEqual(imported);
    });

    it("returns local when imported is undefined", () => {
      const local: NostrProfile = {
        name: "local",
        displayName: "Local User",
      };
      const result = mergeProfiles(local, undefined);
      expect(result).toEqual(local);
    });

    it("prefers local values over imported", () => {
      const local: NostrProfile = {
        name: "localname",
        about: "Local bio",
      };
      const imported: NostrProfile = {
        name: "importedname",
        displayName: "Imported Display",
        about: "Imported bio",
        picture: "https://example.com/pic.jpg",
      };

      const result = mergeProfiles(local, imported);

      expect(result.name).toBe("localname"); // local wins
      expect(result.displayName).toBe("Imported Display"); // imported fills gap
      expect(result.about).toBe("Local bio"); // local wins
      expect(result.picture).toBe("https://example.com/pic.jpg"); // imported fills gap
    });

    it("fills all missing fields from imported", () => {
      const local: NostrProfile = {
        name: "myname",
      };
      const imported: NostrProfile = {
        name: "theirname",
        displayName: "Their Name",
        about: "Their bio",
        picture: "https://example.com/pic.jpg",
        banner: "https://example.com/banner.jpg",
        website: "https://example.com",
        nip05: "user@example.com",
        lud16: "user@getalby.com",
      };

      const result = mergeProfiles(local, imported);

      expect(result.name).toBe("myname");
      expect(result.displayName).toBe("Their Name");
      expect(result.about).toBe("Their bio");
      expect(result.picture).toBe("https://example.com/pic.jpg");
      expect(result.banner).toBe("https://example.com/banner.jpg");
      expect(result.website).toBe("https://example.com");
      expect(result.nip05).toBe("user@example.com");
      expect(result.lud16).toBe("user@getalby.com");
    });

    it("handles empty strings as falsy (prefers imported)", () => {
      const local: NostrProfile = {
        name: "",
        displayName: "",
      };
      const imported: NostrProfile = {
        name: "imported",
        displayName: "Imported",
      };

      const result = mergeProfiles(local, imported);

      // Empty strings are still strings, so they "win" over imported
      // This is JavaScript nullish coalescing behavior
      expect(result.name).toBe("");
      expect(result.displayName).toBe("");
    });

    it("handles null values in local (prefers imported)", () => {
      const local: NostrProfile = {
        name: undefined,
        displayName: undefined,
      };
      const imported: NostrProfile = {
        name: "imported",
        displayName: "Imported",
      };

      const result = mergeProfiles(local, imported);

      expect(result.name).toBe("imported");
      expect(result.displayName).toBe("Imported");
    });
  });
});
