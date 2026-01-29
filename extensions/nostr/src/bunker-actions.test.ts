import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildReplyTags } from "./bunker-actions.js";

// Mock bunker-store
const mockSigner = {
  signEvent: vi.fn(),
};

const mockBunkerConnection = {
  signer: mockSigner,
  userPubkey: "user123pubkey456",
  bunkerPubkey: "bunker123pubkey",
  relays: ["wss://relay.example.com"],
  userWriteRelays: ["wss://write.relay.com"],
  userReadRelays: ["wss://read.relay.com"],
  connectedAt: Date.now(),
  accountId: "test-account",
  bunkerIndex: 0,
};

vi.mock("./bunker-store.js", () => ({
  getBunkerConnection: vi.fn(() => mockBunkerConnection),
  getFirstBunkerConnection: vi.fn(() => mockBunkerConnection),
}));

// Mock runtime
vi.mock("./runtime.js", () => ({
  getNostrRuntime: vi.fn(() => ({
    config: {
      loadConfig: vi.fn(() => ({
        channels: {
          nostr: {
            relays: ["wss://config.relay.com"],
          },
        },
      })),
    },
  })),
}));

// Mock types
vi.mock("./types.js", () => ({
  resolveNostrAccount: vi.fn(() => ({
    relays: ["wss://config.relay.com"],
  })),
}));

// Mock nostr-tools/kinds
vi.mock("nostr-tools/kinds", () => ({
  ShortTextNote: 1,
  Reaction: 7,
  Repost: 6,
  GenericRepost: 16,
  EventDeletion: 5,
  LongFormArticle: 30023,
}));

describe("bunker-actions", () => {
  describe("buildReplyTags", () => {
    it("builds correct tags for direct reply (reply to root)", () => {
      const tags = buildReplyTags({
        replyToId: "event123",
        replyToPubkey: "author123",
      });

      expect(tags).toEqual([
        ["e", "event123", "", "root"],
        ["p", "author123"],
      ]);
    });

    it("builds correct tags for deep reply (reply to non-root)", () => {
      const tags = buildReplyTags({
        replyToId: "reply456",
        replyToPubkey: "replier456",
        rootId: "root123",
        rootPubkey: "rootAuthor123",
      });

      expect(tags).toEqual([
        ["e", "root123", "", "root"],
        ["e", "reply456", "", "reply"],
        ["p", "rootAuthor123"],
        ["p", "replier456"],
      ]);
    });

    it("includes relay hint when provided", () => {
      const tags = buildReplyTags({
        replyToId: "event123",
        replyToPubkey: "author123",
        relayHint: "wss://relay.example.com",
      });

      expect(tags).toEqual([
        ["e", "event123", "wss://relay.example.com", "root"],
        ["p", "author123"],
      ]);
    });

    it("includes additional mentions without duplicates", () => {
      const tags = buildReplyTags({
        replyToId: "event123",
        replyToPubkey: "author123",
        mentions: ["mention1", "mention2", "author123"], // author123 should be deduplicated
      });

      expect(tags).toEqual([
        ["e", "event123", "", "root"],
        ["p", "author123"],
        ["p", "mention1"],
        ["p", "mention2"],
        // author123 not duplicated
      ]);
    });

    it("handles deep reply with same author for root and reply", () => {
      const tags = buildReplyTags({
        replyToId: "reply456",
        replyToPubkey: "author123", // same as root
        rootId: "root123",
        rootPubkey: "author123",
      });

      expect(tags).toEqual([
        ["e", "root123", "", "root"],
        ["e", "reply456", "", "reply"],
        ["p", "author123"],
        // No duplicate p tag
      ]);
    });

    it("handles rootId same as replyToId (no separate reply tag)", () => {
      const tags = buildReplyTags({
        replyToId: "event123",
        replyToPubkey: "author123",
        rootId: "event123", // same as replyToId
        rootPubkey: "author123",
      });

      expect(tags).toEqual([
        ["e", "event123", "", "root"],
        // No reply tag when rootId === replyToId
        ["p", "author123"],
      ]);
    });
  });

  describe("postNote", () => {
    let mockPool: { publish: ReturnType<typeof vi.fn>; querySync: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      vi.clearAllMocks();
      mockPool = {
        publish: vi.fn().mockReturnValue([Promise.resolve("ok")]),
        querySync: vi.fn().mockResolvedValue([]),
      };
      mockSigner.signEvent.mockResolvedValue({
        id: "signed-event-id",
        pubkey: "user123pubkey456",
        kind: 1,
        content: "test content",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        sig: "signature",
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("posts a simple note", async () => {
      const { postNote } = await import("./bunker-actions.js");

      const result = await postNote({
        accountId: "test-account",
        content: "Hello Nostr!",
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(result.eventId).toBe("signed-event-id");
      expect(result.content).toBe("Hello Nostr!");
      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 1,
          content: "Hello Nostr!",
          tags: [],
        })
      );
    });

    it("posts a reply with NIP-10 tags", async () => {
      const { postNote } = await import("./bunker-actions.js");

      await postNote({
        accountId: "test-account",
        content: "This is a reply",
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
        replyTo: "target-event-id",
        replyToPubkey: "target-author-pubkey",
      });

      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 1,
          content: "This is a reply",
          tags: expect.arrayContaining([
            ["e", "target-event-id", "", "root"],
            ["p", "target-author-pubkey"],
          ]),
        })
      );
    });

    it("throws when replyTo is set but replyToPubkey is missing", async () => {
      const { postNote } = await import("./bunker-actions.js");

      await expect(
        postNote({
          accountId: "test-account",
          content: "Invalid reply",
          pool: mockPool as unknown as import("nostr-tools").SimplePool,
          replyTo: "target-event-id",
          // replyToPubkey missing
        })
      ).rejects.toThrow("replyToPubkey is required when replyTo is set");
    });
  });

  describe("postReaction", () => {
    let mockPool: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.clearAllMocks();
      mockPool = {
        publish: vi.fn().mockReturnValue([Promise.resolve("ok")]),
      };
      mockSigner.signEvent.mockResolvedValue({
        id: "reaction-event-id",
        pubkey: "user123pubkey456",
        kind: 7,
        content: "+",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        sig: "signature",
      });
    });

    it("posts a like reaction", async () => {
      const { postReaction } = await import("./bunker-actions.js");

      const result = await postReaction({
        accountId: "test-account",
        eventId: "target-event-id",
        eventPubkey: "target-author-pubkey",
        reaction: "+",
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(result.eventId).toBe("reaction-event-id");
      expect(result.reaction).toBe("+");
      expect(result.targetEventId).toBe("target-event-id");
      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 7,
          content: "+",
          tags: [
            ["e", "target-event-id", ""],
            ["p", "target-author-pubkey"],
            ["k", "1"], // Default kind
          ],
        })
      );
    });

    it("includes k tag for non-note events", async () => {
      const { postReaction } = await import("./bunker-actions.js");

      await postReaction({
        accountId: "test-account",
        eventId: "article-event-id",
        eventPubkey: "article-author-pubkey",
        eventKind: 30023,
        reaction: "🔥",
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 7,
          content: "🔥",
          tags: expect.arrayContaining([["k", "30023"]]),
        })
      );
    });
  });

  describe("postRepost", () => {
    let mockPool: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.clearAllMocks();
      mockPool = {
        publish: vi.fn().mockReturnValue([Promise.resolve("ok")]),
      };
    });

    it("creates kind:6 repost for kind:1 notes", async () => {
      mockSigner.signEvent.mockResolvedValue({
        id: "repost-event-id",
        pubkey: "user123pubkey456",
        kind: 6,
        content: "",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        sig: "signature",
      });

      const { postRepost } = await import("./bunker-actions.js");

      const result = await postRepost({
        accountId: "test-account",
        eventId: "note-event-id",
        eventPubkey: "note-author-pubkey",
        eventKind: 1,
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(result.kind).toBe(6);
      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 6,
          tags: [
            ["e", "note-event-id", ""],
            ["p", "note-author-pubkey"],
          ],
        })
      );
    });

    it("creates kind:16 generic repost for non-note events", async () => {
      mockSigner.signEvent.mockResolvedValue({
        id: "generic-repost-event-id",
        pubkey: "user123pubkey456",
        kind: 16,
        content: "",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        sig: "signature",
      });

      const { postRepost } = await import("./bunker-actions.js");

      const result = await postRepost({
        accountId: "test-account",
        eventId: "article-event-id",
        eventPubkey: "article-author-pubkey",
        eventKind: 30023,
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(result.kind).toBe(16);
      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 16,
          tags: expect.arrayContaining([["k", "30023"]]),
        })
      );
    });
  });

  describe("fetchEvents", () => {
    let mockPool: { querySync: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.clearAllMocks();
      mockPool = {
        querySync: vi.fn().mockResolvedValue([
          {
            id: "event1",
            pubkey: "pubkey1",
            kind: 1,
            content: "Hello",
            tags: [],
            created_at: 1234567890,
            sig: "sig1",
          },
        ]),
      };
    });

    it("fetches events with filter", async () => {
      const { fetchEvents } = await import("./bunker-actions.js");

      const result = await fetchEvents({
        accountId: "test-account",
        filter: { kinds: [1], limit: 10 },
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe("event1");
      expect(mockPool.querySync).toHaveBeenCalledWith(
        expect.any(Array),
        { kinds: [1], limit: 10 },
        expect.any(Object)
      );
    });

    it("uses explicit relays when provided", async () => {
      const { fetchEvents } = await import("./bunker-actions.js");

      await fetchEvents({
        accountId: "test-account",
        filter: { kinds: [1] },
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
        relays: ["wss://explicit.relay.com"],
      });

      expect(mockPool.querySync).toHaveBeenCalledWith(
        ["wss://explicit.relay.com"],
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe("postArticle", () => {
    let mockPool: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.clearAllMocks();
      mockPool = {
        publish: vi.fn().mockReturnValue([Promise.resolve("ok")]),
      };
      mockSigner.signEvent.mockResolvedValue({
        id: "article-event-id",
        pubkey: "user123pubkey456",
        kind: 30023,
        content: "# My Article",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        sig: "signature",
      });
    });

    it("posts a published article (kind:30023)", async () => {
      const { postArticle } = await import("./bunker-actions.js");

      const result = await postArticle({
        accountId: "test-account",
        title: "My Article",
        content: "# My Article\n\nContent here",
        identifier: "my-article",
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(result.eventId).toBe("article-event-id");
      expect(result.title).toBe("My Article");
      expect(result.identifier).toBe("my-article");
      expect(result.kind).toBe(30023);
      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 30023,
          content: "# My Article\n\nContent here",
          tags: expect.arrayContaining([
            ["d", "my-article"],
            ["title", "My Article"],
          ]),
        })
      );
    });

    it("posts a draft article (kind:30024)", async () => {
      mockSigner.signEvent.mockResolvedValue({
        id: "draft-event-id",
        pubkey: "user123pubkey456",
        kind: 30024,
        content: "Draft content",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        sig: "signature",
      });

      const { postArticle } = await import("./bunker-actions.js");

      const result = await postArticle({
        accountId: "test-account",
        title: "Draft Article",
        content: "Draft content",
        identifier: "draft-article",
        isDraft: true,
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(result.kind).toBe(30024);
      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 30024,
        })
      );
    });

    it("includes optional metadata in tags", async () => {
      const { postArticle } = await import("./bunker-actions.js");

      await postArticle({
        accountId: "test-account",
        title: "Full Article",
        content: "Content",
        identifier: "full-article",
        summary: "A summary",
        image: "https://example.com/image.jpg",
        hashtags: ["nostr", "test"],
        pool: mockPool as unknown as import("nostr-tools").SimplePool,
      });

      expect(mockSigner.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining([
            ["summary", "A summary"],
            ["image", "https://example.com/image.jpg"],
            ["t", "nostr"],
            ["t", "test"],
          ]),
        })
      );
    });
  });
});
