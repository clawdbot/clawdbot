import { describe, expect, it, vi } from "vitest";
import { runGetSituationalAwareness } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "6c9176ed-88b4-404f-8b51-70cd63cdeeff";

function withWorkspaceId<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PFM_WORKSPACE_ID;
  process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  return fn().finally(() => {
    if (prior === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = prior;
    }
  });
}

describe("vctraderai-get-situational-awareness egress allowlist", () => {
  it("every captured url on the happy path matches the allowlist", async () => {
    await withWorkspaceId(async () => {
      const urls: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        urls.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof globalThis.fetch;
      await runGetSituationalAwareness(
        { account_id: "acc-1", instrument: "XAUUSD" },
        { fetchImpl },
      );
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
      }
    });
  });

  it("rejects a sibling openclaw path outside this plugin's allowlist", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/openclaw/data/coverage")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/internal/admin/secrets")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects the gateway-protocol admin surface", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/admin/rpc")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects relative-traversal segments inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/situational-awareness/../admin"),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects newline / null-byte injection inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/situational-awareness\nGET /admin"),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    await expect(bffFetch("/api/v1/openclaw/situational-awareness\0/admin")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external URL with a valid-looking prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("https://evil.example.com/api/v1/openclaw/situational-awareness"),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an aborted fetch via AbortSignal", async () => {
    await withWorkspaceId(async () => {
      const controller = new AbortController();
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof globalThis.fetch;
      controller.abort();
      await expect(
        runGetSituationalAwareness({}, { fetchImpl }, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});
