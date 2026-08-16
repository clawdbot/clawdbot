import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { urbitFetch } from "./fetch.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  )),
  fetchWithSsrFGuard: vi.fn(),
}));

describe("urbitFetch guarded response ownership", () => {
  beforeEach(() => {
    vi.mocked(fetchWithSsrFGuard).mockReset();
  });

  it("keeps responses alive until release and preserves guarded metadata", async () => {
    const events: string[] = [];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          events.push("cancel");
        },
      }),
    );
    const release = vi.fn(async () => {
      events.push("release");
    });
    const refreshTimeout = vi.fn();
    const controller = new AbortController();
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: "https://example.com/~/channel/1701",
      release,
      refreshTimeout,
    });

    const guarded = await urbitFetch({
      baseUrl: "https://example.com",
      path: "/~/channel/1701",
      signal: controller.signal,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(guarded.response).toBe(response);
    expect(guarded.finalUrl).toBe("https://example.com/~/channel/1701");
    expect(guarded.refreshTimeout).toBe(refreshTimeout);
    expect(events).toEqual([]);
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        policy: { allowPrivateNetwork: true },
      }),
    );

    await guarded.release();

    expect(events).toEqual(["cancel", "release"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not cancel a response that its owner already consumed", async () => {
    const response = new Response("finished");
    const body = response.body;
    if (!body) {
      throw new Error("expected a response body");
    }
    const cancel = vi.spyOn(body, "cancel");
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: "https://example.com/~/scry/chat.json",
      release,
    });

    const guarded = await urbitFetch({
      baseUrl: "https://example.com",
      path: "/~/scry/chat.json",
    });
    await expect(guarded.response.text()).resolves.toBe("finished");
    await guarded.release();

    expect(cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases a successful response without a body", async () => {
    const response = new Response(null, { status: 204 });
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: "https://example.com/~/channel/1701",
      release,
    });

    const guarded = await urbitFetch({
      baseUrl: "https://example.com",
      path: "/~/channel/1701",
    });

    await expect(guarded.release()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases promptly when a retained response clone keeps cancellation pending", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("still streaming"));
        },
      }),
    );
    const clone = response.clone();
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: "https://example.com/~/channel/1701",
      release,
    });

    const guarded = await urbitFetch({
      baseUrl: "https://example.com",
      path: "/~/channel/1701",
    });
    const releasing = guarded.release();

    try {
      expect(release).toHaveBeenCalledOnce();
      await expect(releasing).resolves.toBeUndefined();
    } finally {
      void clone.body?.cancel().catch(() => undefined);
    }
  });

  it("still releases when response cancellation rejects", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error("cancel failed");
        },
      }),
    );
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: "https://example.com/~/channel/1701",
      release,
    });

    const guarded = await urbitFetch({
      baseUrl: "https://example.com",
      path: "/~/channel/1701",
    });

    await expect(guarded.release()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });
});
