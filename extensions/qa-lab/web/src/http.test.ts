import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, getJsonNoStore, postJson } from "./http.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function responseWithText(text: string, init?: ResponseInit): Response {
  return new Response(text, init);
}

describe("QA Lab dashboard HTTP", () => {
  it("gives every API request a fresh 30 second deadline", async () => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      const controller = controllers.shift();
      if (!controller) {
        throw new Error("unexpected timeout signal request");
      }
      return controller.signal;
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getJson("/api/bootstrap");
    await getJsonNoStore("/api/ui-version");
    await postJson("/api/runner/start", { scenario: "baseline" });

    expect(timeout).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/bootstrap",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/ui-version",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/runner/start",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects a stalled request when its deadline aborts", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("missing request signal");
        }
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              // Fetch rejects with the exact abort reason. DOM types define it as an Error,
              // although jsdom does not preserve that prototype relationship at runtime.
              reject(signal.reason as Error);
            },
            { once: true },
          );
        });
      }),
    );

    const request = getJson("/api/stalled");
    timeoutController.abort(new DOMException("request deadline exceeded", "TimeoutError"));

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("fails closed on non-JSON success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        responseWithText("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    await expect(getJson("/api/bootstrap")).rejects.toThrow(
      /\/api\/bootstrap: expected JSON response/,
    );
  });

  it("fails closed on empty JSON success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        responseWithText("", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getJsonNoStore("/api/ui-version")).rejects.toThrow(
      /\/api\/ui-version: empty JSON response/,
    );
  });

  it("labels malformed JSON success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        responseWithText("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getJson("/api/state")).rejects.toThrow(/\/api\/state: malformed JSON response/);
  });

  it("accepts vendor JSON success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        responseWithText(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/problem+json; charset=utf-8" },
        }),
      ),
    );

    await expect(getJson("/api/bootstrap")).resolves.toEqual({ ok: true });
  });

  it("keeps JSON API error messages readable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        responseWithText(JSON.stringify({ error: "boom" }), {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(postJson("/api/runner/start", { scenario: "baseline" })).rejects.toThrow("boom");
  });

  it("allows large successful JSON responses", async () => {
    const body = JSON.stringify({ data: "x".repeat(128 * 1024) });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        responseWithText(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getJson("/api/state")).resolves.toEqual({ data: "x".repeat(128 * 1024) });
  });
});
