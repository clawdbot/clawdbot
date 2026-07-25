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
  subscribe: vi.fn(),
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      auth = relayMocks.auth;
      close = relayMocks.close;
      connect = relayMocks.connect;
      onauth: unknown;

      subscribe(filters: Array<Record<string, unknown>>, handlers: Record<string, () => void>) {
        relayMocks.filters.push(filters[0] ?? {});
        return relayMocks.subscribe(filters, handlers);
      }
    },
  };
});

const PRIVATE_KEY = "11".repeat(32);
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
            pubkey: "relay",
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
            pubkey: "relay",
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
            pubkey: "relay",
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
      { kinds: [39002], "#p": [publicKey], limit: 1000 },
      { kinds: [39000], "#d": [ROOM_A], limit: 1 },
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
});
