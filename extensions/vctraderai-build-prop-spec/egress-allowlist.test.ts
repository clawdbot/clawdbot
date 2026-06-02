import { describe, expect, it, vi } from "vitest";
import { runBuildPropSpec } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

describe("vctraderai-build-prop-spec egress allowlist", () => {
  it("every captured url on the happy path matches the allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runBuildPropSpec({ challenge_id: "the5ers-100k-stage1" }, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("rejects an internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/internal/admin/secrets", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an attempt to call the gateway-protocol admin surface", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/admin/rpc", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects relative-traversal segments inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/prop-spec/../admin", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects newline / null-byte injection inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/prop-spec/build\nGET /admin", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    await expect(
      bffFetch("/api/v1/openclaw/prop-spec/build\0/admin", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external URL with a valid-looking openclaw prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("https://evil.example.com/api/v1/openclaw/prop-spec/build", {
        method: "POST",
        body: {},
      }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an aborted fetch via AbortSignal", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    controller.abort();
    await expect(
      runBuildPropSpec(
        { challenge_id: "the5ers-100k-stage1" },
        { fetchImpl },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
