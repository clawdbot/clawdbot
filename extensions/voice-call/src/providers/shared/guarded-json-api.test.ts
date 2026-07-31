// Voice Call tests cover guarded json api plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../../api.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { guardedJsonApiRequest } from "./guarded-json-api.js";

function cancelTrackedTextResponse(
  text: string,
  init?: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("guardedJsonApiRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the SSRF-guarded fetch and parses json responses", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      release,
    });

    await expect(
      guardedJsonApiRequest({
        url: "https://api.example.com/v1/calls",
        method: "POST",
        headers: { Authorization: "Bearer token" },
        body: { hello: "world" },
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "request failed",
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://api.example.com/v1/calls",
      init: {
        method: "POST",
        headers: { Authorization: "Bearer token" },
        body: JSON.stringify({ hello: "world" }),
      },
      policy: { allowedHostnames: ["api.example.com"] },
      auditContext: "voice-call:test",
      timeoutMs: 30_000,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for empty bodies and allowed 404s", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(null, { status: 204 }),
      release,
    });

    await expect(
      guardedJsonApiRequest({
        url: "https://api.example.com/v1/calls/1",
        method: "GET",
        headers: {},
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "request failed",
      }),
    ).resolves.toBeUndefined();

    const missing = cancelTrackedTextResponse("missing", { status: 404 });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: missing.response,
      release,
    });

    await expect(
      guardedJsonApiRequest({
        url: "https://api.example.com/v1/calls/2",
        method: "GET",
        headers: {},
        allowNotFound: true,
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "request failed",
      }),
    ).resolves.toBeUndefined();

    expect(missing.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("throws prefixed errors and still releases the response handle", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("boom", { status: 500 }),
      release,
    });

    await expect(
      guardedJsonApiRequest({
        url: "https://api.example.com/v1/calls/3",
        method: "DELETE",
        headers: {},
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "provider error",
      }),
    ).rejects.toThrow("provider error: 500 boom");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds provider error bodies on complete UTF-8 characters and cancels overflow", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedTextResponse(`${"x".repeat(8 * 1024 - 2)}😀tail`, {
      status: 500,
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release,
    });

    let caught: Error | undefined;
    try {
      await guardedJsonApiRequest({
        url: "https://api.example.com/v1/calls/3",
        method: "DELETE",
        headers: {},
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "provider error",
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("provider error: 500 ");
    expect(caught?.message).toContain("... [truncated]");
    expect(caught?.message).not.toContain("�");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("throws prefixed errors for malformed json success responses", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("{not json", { status: 200 }),
      release,
    });

    await expect(
      guardedJsonApiRequest({
        url: "https://api.example.com/v1/calls/4",
        method: "GET",
        headers: {},
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "provider error",
      }),
    ).rejects.toThrow("provider error: malformed JSON response");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized json success bodies and cancels unread overflow", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedTextResponse("x".repeat(1024 * 1024 + 1), { status: 200 });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release,
    });

    await expect(
      guardedJsonApiRequest({
        url: "https://api.example.com/v1/calls/5",
        method: "GET",
        headers: {},
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "provider error",
      }),
    ).rejects.toThrow("provider response body too large: 1048577 bytes (limit: 1048576 bytes)");

    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
