// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importNostrProfile,
  putNostrProfile,
  resolveNostrMutationCandidates,
} from "./nostr-profile-ops.ts";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

function requireRequestSignal(init: RequestInit | undefined): AbortSignal {
  const signal = init?.signal;
  if (!(signal instanceof AbortSignal)) {
    throw new Error("Expected Nostr profile request to carry an AbortSignal");
  }
  return signal;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        const error = new Error("Nostr profile request timed out after 30 seconds");
        error.name = "TimeoutError";
        reject(error);
      },
      { once: true },
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Nostr profile HTTP operations", () => {
  it("aborts a profile PUT when response headers never arrive", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      return await rejectWhenAborted(requireRequestSignal(init));
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = putNostrProfile({
      accountId: "main/account",
      authCandidates: ["test"],
      values: { name: "Alice" },
    });
    const result = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Nostr profile request timed out after 30 seconds",
    });
    await vi.advanceTimersByTimeAsync(NOSTR_PROFILE_REQUEST_TIMEOUT_MS);
    await result;

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/nostr/main%2Faccount/profile",
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test",
        },
        body: JSON.stringify({ name: "Alice" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("keeps the import deadline active while the response body is pending", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = requireRequestSignal(init);
      return {
        ok: true,
        status: 200,
        json: () => rejectWhenAborted(signal),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = importNostrProfile({ accountId: "default" });
    const result = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(NOSTR_PROFILE_REQUEST_TIMEOUT_MS);
    await result;

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/nostr/default/profile/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ autoMerge: true }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("preserves successful JSON responses for PUT and import", async () => {
    const putResponse = new Response(JSON.stringify({ ok: true, persisted: true }), {
      status: 200,
    });
    const importResponse = new Response(
      JSON.stringify({ ok: true, saved: true, merged: { name: "Alice" } }),
      { status: 200 },
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(putResponse)
      .mockResolvedValueOnce(importResponse);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      putNostrProfile({ accountId: "default", values: { name: "Alice" } }),
    ).resolves.toEqual({ data: { ok: true, persisted: true }, response: putResponse });
    await expect(importNostrProfile({ accountId: "default" })).resolves.toEqual({
      data: { ok: true, saved: true, merged: { name: "Alice" } },
      response: importResponse,
    });
  });

  it("falls back to the next credential candidate when the gateway rejects the first one", async () => {
    const auths: (string | undefined)[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      auths.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      if (auths[auths.length - 1] === "Bearer saved-token") {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, persisted: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await putNostrProfile({
      accountId: "default",
      authCandidates: ["saved-token", "password"],
      values: { name: "Alice" },
    });

    expect(result.response.status).toBe(200);
    expect(auths).toEqual(["Bearer saved-token", "Bearer password"]);
    // The original body is replayed with the recovering credential.
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ name: "Alice" }));
  });

  it("does not advance past a 403 scope rejection", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await putNostrProfile({
      accountId: "default",
      authCandidates: ["saved-token", "password"],
      values: { name: "Alice" },
    });

    expect(result.response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not advance to the next credential after the operation is no longer current", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if ((init?.headers as Record<string, string> | undefined)?.Authorization === "Bearer a") {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await putNostrProfile({
      accountId: "default",
      authCandidates: ["a", "b"],
      isCurrent: () => false,
      values: { name: "Alice" },
    });

    expect(result.response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the device token solely as a fallback when no shared credential exists", () => {
    expect(
      resolveNostrMutationCandidates(
        { auth: { deviceToken: "device-token" } },
        { token: "saved-token", password: "password" },
      ),
    ).toEqual(["saved-token", "password"]);
    expect(
      resolveNostrMutationCandidates(
        { auth: { deviceToken: "device-token" } },
        { token: "", password: "" },
      ),
    ).toEqual(["device-token"]);
  });

  it("preserves the response when an error body is not JSON", async () => {
    const response = new Response("gateway unavailable", { status: 503 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(importNostrProfile({ accountId: "default" })).resolves.toEqual({
      data: null,
      response,
    });
  });
});
