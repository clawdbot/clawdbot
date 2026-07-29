// Covers shared provider usage fetch parsing and error snapshots.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  discardUsageResponseBody,
  fetchJson,
  parseFiniteNumber,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";

function requireFetchCall(
  mock: ReturnType<typeof vi.fn>,
): [URL | RequestInfo, RequestInit | undefined] {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call as [URL | RequestInfo, RequestInit | undefined];
}

describe("provider usage fetch shared helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a provider error snapshot", () => {
    expect(buildUsageErrorSnapshot("zai", "API error")).toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      error: "API error",
    });
  });

  it.each([
    { value: 12, expected: 12 },
    { value: "12.5", expected: 12.5 },
    { value: "12.5 credits", expected: undefined },
    { value: "not-a-number", expected: undefined },
  ])("parses finite numbers for %j", ({ value, expected }) => {
    expect(parseFiniteNumber(value)).toBe(expected);
  });

  it("forwards request init with a deadline signal", async () => {
    const fetchFnMock = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        new Response(JSON.stringify({ aborted: init?.signal?.aborted ?? false }), { status: 200 }),
    );
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const response = await fetchJson(
      "https://example.com/usage",
      {
        method: "POST",
        headers: { authorization: "Bearer test" },
      },
      1_000,
      fetchFn,
    );

    expect(fetchFnMock).toHaveBeenCalledOnce();
    const [input, init] = requireFetchCall(fetchFnMock);
    expect(input).toBe("https://example.com/usage");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: "Bearer test" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(response.json()).resolves.toEqual({ aborted: false });
  });

  it("aborts timed out requests", async () => {
    const fetchFnMock = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")), {
            once: true,
          });
        }),
    );
    const fetchFn = withFetchPreconnect(fetchFnMock);

    await expect(fetchJson("https://example.com/usage", {}, 10, fetchFn)).rejects.toThrow(
      "aborted by timeout",
    );
  });

  it("keeps the timeout active while the response body is read", async () => {
    let signal: AbortSignal | undefined;
    const fetchFnMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            signal?.addEventListener("abort", () => controller.error(signal?.reason), {
              once: true,
            });
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const response = await fetchJson("https://example.com/usage", {}, 10, fetchFn);

    await expect(readUsageJson("deepseek", response)).resolves.toEqual({
      ok: false,
      snapshot: expect.objectContaining({
        provider: "deepseek",
        error: "Malformed usage response",
      }),
    });
    expect(signal?.aborted).toBe(true);
  });

  it("keeps caller cancellation active while the response body is read", async () => {
    const callerAbort = new AbortController();
    const callerReason = new Error("cancelled by caller");
    let signal: AbortSignal | undefined;
    const fetchFnMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal?.reason), {
              once: true,
            });
          },
        }),
      );
    });
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const response = await fetchJson(
      "https://example.com/usage",
      { signal: callerAbort.signal },
      1_000,
      fetchFn,
    );
    const bodyRead = response.text();
    callerAbort.abort(callerReason);

    await expect(bodyRead).rejects.toBe(callerReason);
    expect(signal?.reason).toBe(callerReason);
  });

  it("caps oversized request timeouts before scheduling", async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const fetchFnMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const fetchFn = withFetchPreconnect(fetchFnMock);

    await fetchJson("https://example.com/usage", {}, MAX_TIMER_TIMEOUT_MS + 1_000_000, fetchFn);

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
  });

  it("cancels unread response bodies when discarding usage responses", async () => {
    const response = new Response("not needed", { status: 429 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);

    await discardUsageResponseBody(response);

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("maps configured status codes to token expired", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "openai",
      status: 401,
      tokenExpiredStatuses: [401, 403],
    });

    expect(snapshot.error).toBe("Token expired");
    expect(snapshot.provider).toBe("openai");
    expect(snapshot.windows).toHaveLength(0);
  });

  it("includes trimmed API error messages in HTTP errors", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: 403,
      message: " missing scope ",
    });

    expect(snapshot.error).toBe("HTTP 403: missing scope");
  });

  it("omits empty HTTP error message suffixes", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: 429,
      message: "   ",
    });

    expect(snapshot.error).toBe("HTTP 429");
  });

  describe("readUsageJson", () => {
    it("parses a normal-sized JSON response", async () => {
      const response = new Response(
        JSON.stringify({ windows: [{ label: "5h", usedPercent: 42 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

      await expect(readUsageJson("anthropic", response)).resolves.toEqual({
        ok: true,
        data: { windows: [{ label: "5h", usedPercent: 42 }] },
      });
    });

    it("parses UTF-8 BOM-prefixed JSON with fetch-compatible semantics", async () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const json = new TextEncoder().encode(JSON.stringify({ windows: [] }));
      const combined = new Uint8Array(bom.length + json.length);
      combined.set(bom);
      combined.set(json, bom.length);
      const response = new Response(combined, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      await expect(readUsageJson("anthropic", response)).resolves.toEqual({
        ok: true,
        data: { windows: [] },
      });
    });

    it("rejects an oversized JSON response and cancels the stream", async () => {
      let pullCount = 0;
      const cancel = vi.fn(async () => undefined);
      const oversizedStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          controller.enqueue(new Uint8Array(pullCount === 1 ? 16 * 1024 * 1024 + 1 : 1));
        },
        cancel,
      });
      const response = new Response(oversizedStream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      await expect(readUsageJson("anthropic", response)).resolves.toEqual({
        ok: false,
        snapshot: expect.objectContaining({
          provider: "anthropic",
          error: "Malformed usage response",
        }),
      });
      expect(pullCount).toBeLessThanOrEqual(2);
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("handles a JSON parse error gracefully", async () => {
      const response = new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      await expect(readUsageJson("openai", response)).resolves.toEqual({
        ok: false,
        snapshot: expect.objectContaining({
          provider: "openai",
          error: "Malformed usage response",
        }),
      });
    });

    it("preserves provider name in malformed error snapshots", async () => {
      const response = new Response("", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      await expect(readUsageJson("deepseek", response)).resolves.toEqual({
        ok: false,
        snapshot: expect.objectContaining({ provider: "deepseek" }),
      });
    });
  });
});
