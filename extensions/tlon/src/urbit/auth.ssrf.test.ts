// Tlon tests cover auth.ssrf plugin behavior.
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth.js";

const privateLookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

describe("tlon urbit auth ssrf", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks private IPs by default", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(authenticate("http://127.0.0.1:8080", "code")).rejects.toBeInstanceOf(
      SsrFBlockedError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows private IPs when allowPrivateNetwork is enabled", async () => {
    const response = new Response("ok", {
      status: 200,
      headers: { "set-cookie": "urbauth-~zod=123; Path=/; HttpOnly" },
    });
    const mockFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", mockFetch);

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: privateLookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(cookie).toContain("urbauth-~zod=123");
    expect(response.bodyUsed).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("cancels an open body stream as soon as the drain cap is reached", async () => {
    const cookieValue = "urbauth-~zod=789; Path=/; HttpOnly";
    const cappedBody = new Uint8Array(64 * 1024).fill(0x78);
    let canceled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(cappedBody);
      },
      cancel() {
        canceled = true;
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "set-cookie": cookieValue },
    });

    const mockFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", mockFetch);

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: privateLookupFn,
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(cookie).toContain("urbauth-~zod=789");
    expect(canceled).toBe(true);
  });

  it("cancels failed login bodies before throwing", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("login failed"));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 401 },
    );
    const mockFetch = vi.fn().mockResolvedValue(response);

    await expect(
      authenticate("http://127.0.0.1:8080", "bad-code", {
        ssrfPolicy: { allowPrivateNetwork: true },
        lookupFn: privateLookupFn,
        fetchImpl: mockFetch as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "auth_failed" });
    expect(canceled).toBe(true);
  });
});
