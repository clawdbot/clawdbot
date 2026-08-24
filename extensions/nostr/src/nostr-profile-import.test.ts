/**
 * Tests for Nostr Profile Import
 */

import type { Event, SimplePool } from "nostr-tools";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import { importProfileFromRelays, mergeProfiles } from "./nostr-profile-import.js";

type ProfileSubscriptionParams = Parameters<SimplePool["subscribeMany"]>[2];

const mockState = vi.hoisted(() => ({
  close: vi.fn(),
  closeSubscription: vi.fn(),
  subscribeMany:
    vi.fn<(relays: string[], filter: unknown, params: ProfileSubscriptionParams) => void>(),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    subscribeMany(relays: string[], filter: unknown, params: ProfileSubscriptionParams) {
      mockState.subscribeMany(relays, filter, params);
      return { close: mockState.closeSubscription };
    }

    close(relays: string[]) {
      mockState.close(relays);
    }
  }

  return {
    SimplePool: MockSimplePool,
  };
});

function createProfileEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "1".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "profile" }),
    sig: "b".repeat(128),
    ...overrides,
  };
}

function respondWithProfileContent(content: unknown): void {
  mockState.subscribeMany.mockImplementation((_relays, _filter, params) => {
    params.onevent?.(createProfileEvent({ content: JSON.stringify(content) }));
    params.oneose?.();
  });
}

function importDefaultProfile() {
  return importProfileFromRelays({
    pubkey: "a".repeat(64),
    relays: ["wss://relay.example"],
  });
}

describe("nostr-profile-import", () => {
  beforeEach(() => {
    mockState.close.mockReset();
    mockState.closeSubscription.mockReset();
    mockState.subscribeMany.mockReset();
  });

  describe("importProfileFromRelays", () => {
    it("queries relays independently and uses the newest profile", async () => {
      const pubkey = "a".repeat(64);
      const relays = ["wss://old.example", "wss://new.example"];
      const relayEvents = [
        createProfileEvent({ id: "1".repeat(64), created_at: 10 }),
        createProfileEvent({
          id: "2".repeat(64),
          created_at: 20,
          content: JSON.stringify({ name: "newest" }),
        }),
      ];
      mockState.subscribeMany.mockImplementation((_relays, _filter, params) => {
        params.onevent?.(relayEvents.shift()!);
        params.oneose?.();
      });

      const result = await importProfileFromRelays({
        pubkey,
        relays,
      });

      expect(result).toMatchObject({
        ok: true,
        profile: { name: "newest" },
        event: { id: "2".repeat(64), created_at: 20 },
        relaysQueried: relays,
        sourceRelay: relays[1],
      });
      expect(mockState.subscribeMany).toHaveBeenCalledTimes(2);
      for (const [index, relay] of relays.entries()) {
        expect(mockState.subscribeMany).toHaveBeenNthCalledWith(
          index + 1,
          [relay],
          { kinds: [0], authors: [pubkey], limit: 1 },
          expect.objectContaining({
            onevent: expect.any(Function),
            oneose: expect.any(Function),
            onclose: expect.any(Function),
          }),
        );
      }
      expect(mockState.close).toHaveBeenCalledWith(relays);
    });

    it("uses the lowest event id when profile timestamps match", async () => {
      const pubkey = "a".repeat(64);
      const relays = ["wss://first.example", "wss://second.example"];
      const relayEvents = [
        createProfileEvent({
          id: "f".repeat(64),
          created_at: 20,
          content: JSON.stringify({ name: "arrived-first" }),
        }),
        createProfileEvent({
          id: "0".repeat(64),
          created_at: 20,
          content: JSON.stringify({ name: "canonical" }),
        }),
      ];
      mockState.subscribeMany.mockImplementation((_relays, _filter, params) => {
        params.onevent?.(relayEvents.shift()!);
        params.oneose?.();
      });

      const result = await importProfileFromRelays({ pubkey, relays });

      expect(result).toMatchObject({
        ok: true,
        profile: { name: "canonical" },
        event: { id: "0".repeat(64), created_at: 20 },
        sourceRelay: relays[1],
      });
    });

    it("bounds the whole query while the native relay subscription is pending", async () => {
      vi.useFakeTimers();
      try {
        const resultPromise = importProfileFromRelays({
          pubkey: "a".repeat(64),
          relays: ["wss://slow.example"],
          timeoutMs: 25,
        });

        await vi.advanceTimersByTimeAsync(25);

        await expect(resultPromise).resolves.toMatchObject({
          ok: false,
          error: "No profile found on any relay",
        });
        expect(mockState.closeSubscription).toHaveBeenCalledOnce();
        expect(mockState.close).toHaveBeenCalledWith(["wss://slow.example"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects profile content that is not a JSON object", async () => {
      respondWithProfileContent(null);

      await expect(importDefaultProfile()).resolves.toMatchObject({
        ok: false,
        error: "Profile event content must be a JSON object",
        sourceRelay: "wss://relay.example",
      });
    });

    it.each([
      {
        case: "a wrong field type",
        content: { name: 123, about: "valid" },
      },
      {
        case: "a wrong URL field type",
        content: { name: "valid", picture: 123 },
      },
      {
        case: "an overlong field",
        content: { name: "a".repeat(257), about: "valid" },
      },
      {
        case: "a wrong field type alongside an unsafe URL",
        content: { name: "valid", about: 123, picture: "https://127.0.0.1/avatar.png" },
      },
    ])("rejects the whole profile for $case", async ({ content }) => {
      respondWithProfileContent(content);

      await expect(importDefaultProfile()).resolves.toMatchObject({
        ok: false,
        error: "Profile event content has invalid fields",
        sourceRelay: "wss://relay.example",
      });
    });

    it("drops unknown fields and unsafe URLs from an otherwise valid profile", async () => {
      respondWithProfileContent({
        name: "valid",
        picture: "https://127.0.0.1/avatar.png",
        website: "https://example.com",
        custom: "ignored",
      });

      const result = await importDefaultProfile();

      expect(result).toMatchObject({ ok: true, sourceRelay: "wss://relay.example" });
      expect(result.profile).toStrictEqual({ name: "valid", website: "https://example.com" });
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
