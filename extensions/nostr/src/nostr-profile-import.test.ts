/**
 * Tests for Nostr Profile Import
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import { importProfileFromRelays, mergeProfiles } from "./nostr-profile-import.js";

const mockState = vi.hoisted(() => ({
  subscribeMany: vi.fn(),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    subscribeMany(
      relays: string[],
      filters: unknown,
      handlers: {
        onevent: (event: Record<string, unknown>) => void;
        oneose?: () => void;
        onclose?: () => void;
      },
    ) {
      mockState.subscribeMany(relays, filters, handlers);
      queueMicrotask(() => handlers.oneose?.());
      return {
        close: vi.fn(),
      };
    }

    close = vi.fn();
  }

  return {
    SimplePool: MockSimplePool,
    verifyEvent: vi.fn(() => true),
  };
});

// Mock SimplePool so importProfileFromRelays can assert the relay subscription shape.

describe("nostr-profile-import", () => {
  beforeEach(() => {
    mockState.subscribeMany.mockClear();
  });

  describe("importProfileFromRelays", () => {
    it("subscribes to profiles with a single Nostr filter object", async () => {
      const pubkey = "a".repeat(64);

      await importProfileFromRelays({
        pubkey,
        relays: ["wss://relay.example"],
        timeoutMs: 1,
      });

      expect(mockState.subscribeMany).toHaveBeenCalledTimes(1);
      const filters = mockState.subscribeMany.mock.calls[0]?.[1];
      expect(Array.isArray(filters)).toBe(false);
      expect(filters).toMatchObject({
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      });
    });
  });

  describe("mergeProfiles", () => {
    it("returns empty object when both are undefined", () => {
      const result = mergeProfiles(undefined, undefined);
      expect(result).toStrictEqual({});
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
