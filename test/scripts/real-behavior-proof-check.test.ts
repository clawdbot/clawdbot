// Real Behavior Proof Check tests cover real behavior proof check script behavior.
import { describe, expect, it, vi } from "vitest";
import { fetchProofComments } from "../../scripts/github/real-behavior-proof-check.mjs";

function stalledResponse() {
  let keepAlive: ReturnType<typeof setTimeout> | undefined;
  const reader = {
    read: () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>(() => {
        keepAlive = setTimeout(() => {}, 10_000);
      }),
    cancel: vi.fn(() => {
      if (keepAlive) {
        clearTimeout(keepAlive);
      }
      return Promise.resolve();
    }),
    releaseLock: vi.fn(),
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => reader,
    },
  };
}

function contentLengthResponse(contentLength: number) {
  const cancel = vi.fn(() => Promise.resolve());
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(contentLength) }),
    body: { cancel },
    cancel,
  };
}

function chunkedResponse(chunks: Uint8Array[]) {
  const cancel = vi.fn(() => Promise.resolve());
  const read = vi.fn();
  for (const chunk of chunks) {
    read.mockResolvedValueOnce({ done: false, value: chunk });
  }
  read.mockResolvedValueOnce({ done: true, value: undefined });
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read,
        cancel,
        releaseLock: vi.fn(),
      }),
    },
  };
}

describe("real-behavior-proof-check GitHub lookups", () => {
  it("aborts stalled proof comment fetches", async () => {
    const fetch = vi.fn((_url: URL, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(toLintErrorObject(init.signal?.reason, "Non-Error rejection")),
        );
      });
    });

    await expect(
      fetchProofComments({
        fetchImpl: fetch as typeof globalThis.fetch,
        issueNumber: 123,
        owner: "openclaw",
        repo: "openclaw",
        timeoutMs: 5,
        tokens: ["tok"],
      }),
    ).rejects.toThrow(/proof comment lookup page 1 timed out after 5ms/);
  });

  it("times out stalled proof comment response bodies", async () => {
    const fetch = vi.fn().mockResolvedValue(stalledResponse());

    await expect(
      fetchProofComments({
        fetchImpl: fetch as typeof globalThis.fetch,
        issueNumber: 123,
        owner: "openclaw",
        repo: "openclaw",
        timeoutMs: 5,
        tokens: ["tok"],
      }),
    ).rejects.toThrow(/proof comment response page 1 timed out after 5ms/);
  });

  it("skips oversized proof comment bodies by content length after narrow fallback", async () => {
    const response = contentLengthResponse(1024 * 1024 + 1);
    const fetch = vi.fn((url: URL) => {
      const perPage = url.searchParams.get("per_page");
      const page = url.searchParams.get("page");
      if ((perPage === "100" && page === "1") || (perPage === "1" && page === "1")) {
        return Promise.resolve(response);
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    });

    await expect(
      fetchProofComments({
        fetchImpl: fetch as typeof globalThis.fetch,
        issueNumber: 123,
        owner: "openclaw",
        repo: "openclaw",
        tokens: ["tok"],
      }),
    ).resolves.toEqual([]);
    expect(response.cancel).toHaveBeenCalled();
  });

  it("skips oversized streamed proof comment bodies after narrow fallback", async () => {
    const encoder = new TextEncoder();
    const oversizedResponse = () =>
      chunkedResponse([
        encoder.encode("["),
        encoder.encode(" ".repeat(1024 * 1024)),
        encoder.encode("]"),
      ]);
    const fetch = vi.fn((url: URL) => {
      const perPage = url.searchParams.get("per_page");
      const page = url.searchParams.get("page");
      if ((perPage === "100" && page === "1") || (perPage === "1" && page === "1")) {
        return Promise.resolve(oversizedResponse());
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    });

    await expect(
      fetchProofComments({
        fetchImpl: fetch as typeof globalThis.fetch,
        issueNumber: 123,
        owner: "openclaw",
        repo: "openclaw",
        tokens: ["tok"],
      }),
    ).resolves.toEqual([]);
  });

  it("falls back to one-comment pages when a bulk comment page is oversized", async () => {
    const fetch = vi.fn((url: URL) => {
      const perPage = url.searchParams.get("per_page");
      const page = url.searchParams.get("page");
      if (perPage === "100" && page === "1") {
        return Promise.resolve(contentLengthResponse(1024 * 1024 + 1));
      }
      if (perPage === "1" && page === "1") {
        return Promise.resolve(contentLengthResponse(1024 * 1024 + 1));
      }
      if (perPage === "1" && page === "2") {
        return Promise.resolve(new Response('[{"id":2,"body":"trusted proof"}]', { status: 200 }));
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    });

    await expect(
      fetchProofComments({
        fetchImpl: fetch as typeof globalThis.fetch,
        issueNumber: 123,
        owner: "openclaw",
        repo: "openclaw",
        tokens: ["tok"],
      }),
    ).resolves.toEqual([{ id: 2, body: "trusted proof" }]);

    expect(
      fetch.mock.calls.map(
        ([url]) => `${url.searchParams.get("per_page")}:${url.searchParams.get("page")}`,
      ),
    ).toEqual(["100:1", "1:1", "1:2", "1:3"]);
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
