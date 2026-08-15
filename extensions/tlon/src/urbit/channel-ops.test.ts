// Tlon tests cover channel ops plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUrbitChannelOpen, scryUrbitPath } from "./channel-ops.js";
import { urbitFetch } from "./fetch.js";

vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

const CHANNEL_DEPS = {
  baseUrl: "https://example.com",
  cookie: "urbauth-~zod=123",
  ship: "~zod",
  channelId: "1701",
};

function mockGuardedResponse(response: Response, finalUrl: string) {
  const state = { bodyUsedAtRelease: undefined as boolean | undefined };
  const release = vi.fn(async () => {
    if (!response.bodyUsed) {
      void response.body?.cancel().catch(() => undefined);
    }
    state.bodyUsedAtRelease = response.bodyUsed;
  });
  vi.mocked(urbitFetch).mockResolvedValueOnce({ response, finalUrl, release });
  return state;
}

describe("Urbit channel operations", () => {
  beforeEach(() => {
    vi.mocked(urbitFetch).mockReset();
  });

  it("rejects malformed scry response JSON", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(urbitFetch).mockResolvedValue({
      response: new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(
      scryUrbitPath(
        {
          baseUrl: "https://example.com",
          cookie: "urbauth-~zod=123",
        },
        { path: "/chat/inbox.json", auditContext: "test" },
      ),
    ).rejects.toThrow("Tlon scry response for path /chat/inbox.json: malformed JSON response");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels the unread scry error body before release", async () => {
    const state = mockGuardedResponse(
      new Response("ship exploded", { status: 500 }),
      "https://example.com/~/scry/chat/inbox.json",
    );

    await expect(
      scryUrbitPath(CHANNEL_DEPS, { path: "/chat/inbox.json", auditContext: "test" }),
    ).rejects.toThrow("Scry for path /chat/inbox.json");
    expect(state.bodyUsedAtRelease).toBe(true);
  });

  it("cancels the unread channel creation error body before release", async () => {
    const state = mockGuardedResponse(
      new Response("ship exploded", { status: 500 }),
      "https://example.com/~/channel/1701",
    );

    await expect(
      ensureUrbitChannelOpen(CHANNEL_DEPS, { createBody: [], createAuditContext: "test" }),
    ).rejects.toThrow("Channel creation");
    expect(state.bodyUsedAtRelease).toBe(true);
  });

  it("cancels the unread channel activation error body before release", async () => {
    mockGuardedResponse(new Response(null, { status: 204 }), "https://example.com/~/channel/1701");
    const wakeState = mockGuardedResponse(
      new Response("ship exploded", { status: 500 }),
      "https://example.com/~/channel/1701",
    );

    await expect(
      ensureUrbitChannelOpen(CHANNEL_DEPS, { createBody: [], createAuditContext: "test" }),
    ).rejects.toThrow("Channel activation");
    expect(wakeState.bodyUsedAtRelease).toBe(true);
  });

  it("releases promptly when error body cancellation never settles", async () => {
    const response = new Response("ship exploded", { status: 500 });
    const body = response.body;
    if (!body) {
      throw new Error("expected a readable error body");
    }
    // Debug-proxy capture can tee the stream so cancel() never resolves; release
    // must still run promptly instead of awaiting the cancellation.
    vi.spyOn(body, "cancel").mockImplementation(() => new Promise<void>(() => {}));
    let released = false;
    const release = vi.fn(async () => {
      void body.cancel().catch(() => undefined);
      released = true;
    });
    vi.mocked(urbitFetch).mockResolvedValueOnce({
      response,
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(
      scryUrbitPath(CHANNEL_DEPS, { path: "/chat/inbox.json", auditContext: "test" }),
    ).rejects.toThrow("Scry for path /chat/inbox.json");
    expect(released).toBe(true);
  });
});
