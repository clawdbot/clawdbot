import { getPublicKey, type Event, type Filter } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  auth: vi.fn(async () => "ok"),
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  filters: [] as Filter[],
  roomArchived: false,
  send: vi.fn(async () => {}),
  subscribe: vi.fn(),
}));
const gatewayMocks = vi.hoisted(() => ({
  activeBus: undefined as
    | {
        directory: {
          listGroups: (params: { query?: string | null; limit?: number | null }) => unknown[];
          listGroupMembers: (params: { groupId: string; limit?: number | null }) => unknown[];
          listPeers: (params: { query?: string | null; limit?: number | null }) => unknown[];
          self: () => unknown;
        };
        refreshDirectory: () => Promise<void>;
      }
    | undefined,
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      auth = relayMocks.auth;
      close = relayMocks.close;
      connect = relayMocks.connect;
      idleSince: number | undefined;
      ongoingOperations = 0;
      onauth: unknown;
      scheduleIdleClose = vi.fn();
      send = relayMocks.send;

      prepareSubscription(
        filters: Filter[],
        handlers: {
          onevent: (event: Event) => void;
          oneose: () => void;
        },
      ) {
        const filter = filters[0] ?? {};
        relayMocks.filters.push(filter);
        const subscription = relayMocks.subscribe(filter, handlers);
        return {
          id: `sub:${relayMocks.filters.length}`,
          ...subscription,
        };
      }
    },
  };
});

vi.mock("./gateway.js", () => ({
  getActiveBuzzBus: () => gatewayMocks.activeBus,
}));

const PRIVATE_KEY = "11".repeat(32);
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const MEMBER_PUBLIC_KEY = "b".repeat(64);
const RELAY_PUBLIC_KEY = "c".repeat(64);
const ROOM_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";

function event(params: Partial<Event> & Pick<Event, "kind" | "pubkey">): Event {
  return {
    id: params.id ?? "f".repeat(64),
    kind: params.kind,
    pubkey: params.pubkey,
    created_at: params.created_at ?? 1_700_000_000,
    content: params.content ?? "",
    sig: params.sig ?? "e".repeat(128),
    tags: params.tags ?? [],
  };
}

describe("Buzz live directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayMocks.filters.length = 0;
    relayMocks.roomArchived = false;
    gatewayMocks.activeBus = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          self: RELAY_PUBLIC_KEY,
          software: "https://github.com/block/buzz",
        }),
      })),
    );
    relayMocks.subscribe.mockImplementation(
      (
        filter: Filter,
        handlers: {
          onevent: (event: Event) => void;
          oneose: () => void;
        },
      ) => {
        if (filter.kinds?.includes(39_002)) {
          handlers.onevent(
            event({
              kind: 39_002,
              pubkey: RELAY_PUBLIC_KEY,
              tags: [
                ["d", ROOM_ID],
                ["p", BOT_PUBLIC_KEY, "", "bot"],
                ["p", MEMBER_PUBLIC_KEY, "", "member"],
              ],
            }),
          );
        } else if (filter.kinds?.includes(39_000)) {
          handlers.onevent(
            event({
              kind: 39_000,
              pubkey: RELAY_PUBLIC_KEY,
              tags: [
                ["d", ROOM_ID],
                ["name", "Engineering"],
                ...(relayMocks.roomArchived ? [["archived", "true"]] : []),
              ],
            }),
          );
        } else if (filter.kinds?.includes(0)) {
          handlers.onevent(
            event({
              kind: 0,
              pubkey: MEMBER_PUBLIC_KEY,
              content: JSON.stringify({
                display_name: "Alice",
                picture: "https://example.com/alice.png",
              }),
            }),
          );
        }
        handlers.oneose();
        return { close: vi.fn() };
      },
    );
  });

  it("loads current room membership and member profiles in one authenticated snapshot", async () => {
    const { listBuzzDirectoryPeersLive } = await import("./directory.js");
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [ROOM_ID]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listBuzzDirectoryPeersLive({
        cfg,
        accountId: "default",
        query: "alice",
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "user",
        id: MEMBER_PUBLIC_KEY,
        name: "Alice",
        avatarUrl: "https://example.com/alice.png",
      }),
    ]);

    expect(relayMocks.filters).toEqual([
      {
        kinds: [39_000],
        authors: [RELAY_PUBLIC_KEY],
        "#d": [ROOM_ID],
        limit: 1,
      },
      {
        kinds: [39_002],
        authors: [RELAY_PUBLIC_KEY],
        "#d": [ROOM_ID],
        limit: 1,
      },
      { kinds: [0], authors: [BOT_PUBLIC_KEY, MEMBER_PUBLIC_KEY], limit: 2 },
    ]);
    expect(relayMocks.auth).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("does not load peers or memberships from archived rooms", async () => {
    relayMocks.roomArchived = true;
    const { listBuzzDirectoryPeersLive } = await import("./directory.js");
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [ROOM_ID]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listBuzzDirectoryPeersLive({
        cfg,
        accountId: "default",
      }),
    ).resolves.toEqual([]);

    expect(relayMocks.filters).toEqual([
      {
        kinds: [39_000],
        authors: [RELAY_PUBLIC_KEY],
        "#d": [ROOM_ID],
        limit: 1,
      },
      { kinds: [0], authors: [BOT_PUBLIC_KEY], limit: 1 },
    ]);
  });

  it("refreshes only room listings when an active bus already owns directory state", async () => {
    const refreshDirectory = vi.fn(async () => {});
    const self = vi.fn(() => ({ kind: "user", id: BOT_PUBLIC_KEY, name: "OpenClaw" }));
    const listPeers = vi.fn(() => [{ kind: "user", id: MEMBER_PUBLIC_KEY, name: "Alice" }]);
    const listGroups = vi.fn(() => [{ kind: "group", id: `buzz:${ROOM_ID}`, name: "Engineering" }]);
    const listGroupMembers = vi.fn(() => [{ kind: "user", id: MEMBER_PUBLIC_KEY, name: "Alice" }]);
    gatewayMocks.activeBus = {
      directory: { self, listPeers, listGroups, listGroupMembers },
      refreshDirectory,
    };
    const {
      getBuzzDirectorySelf,
      listBuzzDirectoryGroupMembers,
      listBuzzDirectoryGroupsLive,
      listBuzzDirectoryPeersLive,
    } = await import("./directory.js");
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [ROOM_ID]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    await getBuzzDirectorySelf({ cfg, accountId: "default" });
    await listBuzzDirectoryPeersLive({ cfg, accountId: "default" });
    await listBuzzDirectoryGroupMembers({ cfg, accountId: "default", groupId: ROOM_ID });
    expect(refreshDirectory).not.toHaveBeenCalled();

    await listBuzzDirectoryGroupsLive({ cfg, accountId: "default" });
    expect(refreshDirectory).toHaveBeenCalledOnce();
    expect(relayMocks.connect).not.toHaveBeenCalled();
  });

  it("returns the active directory snapshot when room metadata refresh fails", async () => {
    const refreshDirectory = vi.fn(async () => {
      throw new Error("relay stalled");
    });
    gatewayMocks.activeBus = {
      directory: {
        self: () => null,
        listPeers: () => [],
        listGroupMembers: () => [],
        listGroups: () => [{ kind: "group", id: `buzz:${ROOM_ID}`, name: "Cached Engineering" }],
      },
      refreshDirectory,
    };
    const { listBuzzDirectoryGroupsLive } = await import("./directory.js");

    await expect(
      listBuzzDirectoryGroupsLive({
        cfg: {
          channels: {
            buzz: {
              relayUrl: "wss://buzz.example.com",
              privateKey: PRIVATE_KEY,
              groups: { [ROOM_ID]: {} },
            },
          },
        } as unknown as OpenClawConfig,
        accountId: "default",
      }),
    ).resolves.toEqual([{ kind: "group", id: `buzz:${ROOM_ID}`, name: "Cached Engineering" }]);
  });
});
