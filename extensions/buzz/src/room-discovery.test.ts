import { getPublicKey } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthSigner = (template: {
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}) => Promise<{ tags: string[][] }>;

const relayMocks = vi.hoisted(() => ({
  auth: vi.fn(async (_signAuth: AuthSigner) => "ok"),
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  filters: [] as Array<Record<string, unknown>>,
  send: vi.fn(async () => {}),
  subscribe: vi.fn(),
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      private isConnected = true;
      auth = relayMocks.auth;
      close = () => {
        this.isConnected = false;
        relayMocks.close();
      };
      connect = relayMocks.connect;
      get connected() {
        return this.isConnected;
      }
      idleSince: number | undefined;
      ongoingOperations = 0;
      onauth: unknown;
      scheduleIdleClose = vi.fn();
      send = relayMocks.send;

      prepareSubscription(
        filters: Array<Record<string, unknown>>,
        handlers: Record<string, () => void>,
      ) {
        relayMocks.filters.push(filters[0] ?? {});
        const subscription = relayMocks.subscribe(filters, handlers);
        return {
          id: `sub:${relayMocks.filters.length}`,
          ...subscription,
        };
      }
    },
  };
});

const PRIVATE_KEY = "11".repeat(32);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const ROOM_A = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const ROOM_B = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";
const AUTH_TAG = ["auth", "bot", "kind=9", "signature"];

describe("discoverBuzzRooms", () => {
  beforeEach(() => {
    relayMocks.auth.mockClear();
    relayMocks.close.mockClear();
    relayMocks.connect.mockClear();
    relayMocks.filters.length = 0;
    relayMocks.subscribe.mockReset();
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
  });

  it("discovers only rooms whose member event names the bot public key", async () => {
    const publicKey = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
    let signedAuthTags: string[][] | undefined;
    relayMocks.auth.mockImplementationOnce(async (signAuth: AuthSigner) => {
      signedAuthTags = (await signAuth({ kind: 22242, created_at: 1, content: "", tags: [] })).tags;
      return "ok";
    });
    relayMocks.subscribe
      .mockImplementationOnce(
        (
          _filters: unknown,
          handlers: { onevent: (event: unknown) => void; oneose: () => void },
        ) => {
          handlers.onevent({
            id: "member-a",
            kind: 39002,
            pubkey: RELAY_PUBLIC_KEY,
            created_at: 1,
            content: "",
            sig: "sig",
            tags: [
              ["d", ROOM_A],
              ["p", publicKey, "", "bot"],
            ],
          });
          handlers.onevent({
            id: "member-b-wrong-role",
            kind: 39002,
            pubkey: RELAY_PUBLIC_KEY,
            created_at: 1,
            content: "",
            sig: "sig",
            tags: [
              ["d", ROOM_B],
              ["p", publicKey, "", "member"],
            ],
          });
          handlers.oneose();
          return { close: vi.fn() };
        },
      )
      .mockImplementationOnce(
        (
          _filters: unknown,
          handlers: { onevent: (event: unknown) => void; oneose: () => void },
        ) => {
          handlers.onevent({
            id: "metadata-a",
            kind: 39000,
            pubkey: RELAY_PUBLIC_KEY,
            created_at: 2,
            content: "",
            sig: "sig",
            tags: [
              ["d", ROOM_A],
              ["name", "Agent room"],
              ["about", "Humans and agents"],
            ],
          });
          handlers.oneose();
          return { close: vi.fn() };
        },
      );

    const { discoverBuzzRooms } = await import("./room-discovery.js");
    await expect(
      discoverBuzzRooms({
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        authTag: JSON.stringify(AUTH_TAG),
      }),
    ).resolves.toEqual([
      {
        id: ROOM_A,
        name: "Agent room",
        about: "Humans and agents",
      },
    ]);

    expect(relayMocks.filters).toEqual([
      {
        kinds: [39002],
        authors: [RELAY_PUBLIC_KEY],
        "#p": [publicKey],
        limit: 1000,
      },
      {
        kinds: [39000],
        authors: [RELAY_PUBLIC_KEY],
        "#d": [ROOM_A],
        limit: 1,
      },
    ]);
    expect(relayMocks.auth).toHaveBeenCalledOnce();
    expect(signedAuthTags).toContainEqual(AUTH_TAG);
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("applies one timeout budget to authentication and closes the relay", async () => {
    relayMocks.auth.mockImplementationOnce(
      async (_signAuth) => await new Promise<string>(() => {}),
    );

    const { discoverBuzzRooms } = await import("./room-discovery.js");
    await expect(
      discoverBuzzRooms({
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        timeoutMs: 10,
      }),
    ).rejects.toThrow();

    expect(relayMocks.close).toHaveBeenCalledOnce();
    expect(relayMocks.subscribe).not.toHaveBeenCalled();
  });

  it("excludes rooms whose latest relay metadata marks them archived", async () => {
    const publicKey = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
    relayMocks.subscribe
      .mockImplementationOnce(
        (
          _filters: unknown,
          handlers: { onevent: (event: unknown) => void; oneose: () => void },
        ) => {
          handlers.onevent({
            id: "member-a",
            kind: 39002,
            pubkey: RELAY_PUBLIC_KEY,
            created_at: 1,
            content: "",
            sig: "sig",
            tags: [
              ["d", ROOM_A],
              ["p", publicKey, "", "bot"],
            ],
          });
          handlers.oneose();
          return { close: vi.fn() };
        },
      )
      .mockImplementationOnce(
        (
          _filters: unknown,
          handlers: { onevent: (event: unknown) => void; oneose: () => void },
        ) => {
          handlers.onevent({
            id: "a".repeat(64),
            kind: 39000,
            pubkey: RELAY_PUBLIC_KEY,
            created_at: 2,
            content: "",
            sig: "sig",
            tags: [
              ["d", ROOM_A],
              ["name", "Old room name"],
            ],
          });
          handlers.onevent({
            id: "b".repeat(64),
            kind: 39000,
            pubkey: RELAY_PUBLIC_KEY,
            created_at: 3,
            content: "",
            sig: "sig",
            tags: [
              ["d", ROOM_A],
              ["name", "Archived room"],
              ["archived", "true"],
            ],
          });
          handlers.oneose();
          return { close: vi.fn() };
        },
      );

    const { discoverBuzzRooms } = await import("./room-discovery.js");
    await expect(
      discoverBuzzRooms({
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
      }),
    ).resolves.toEqual([]);
  });

  it("recycles the relay when a room query never reaches EOSE", async () => {
    vi.useFakeTimers();
    relayMocks.subscribe.mockReturnValue({ close: vi.fn() });

    const { discoverBuzzRooms } = await import("./room-discovery.js");
    const discovery = discoverBuzzRooms({
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      timeoutMs: 10_000,
    });

    const rejection = expect(discovery).rejects.toThrow("Timed out querying Buzz room membership");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(relayMocks.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
