import { describe, expect, it, vi } from "vitest";
import { fetchProofComments } from "../../scripts/github/real-behavior-proof-check.mjs";

describe("real-behavior-proof-check GitHub lookups", () => {
  it("aborts stalled proof comment fetches", async () => {
    const fetch = vi.fn((_url: URL, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
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
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
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
    ).rejects.toThrow(/proof comment response page 1 timed out after 5ms/);
  });
});
