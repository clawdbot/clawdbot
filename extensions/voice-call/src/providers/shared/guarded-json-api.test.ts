import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../../api.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { guardedJsonApiRequest } from "./guarded-json-api.js";

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

    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("missing", { status: 404 }),
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
});
