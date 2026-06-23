import { describe, expect, it, vi } from "vitest";
import { runVolumeProfile } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

describe("vctraderai-volume-profile egress allowlist", () => {
  it("every captured url on the happy path matches the data-cluster allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runVolumeProfile({ symbol: "EUR_USD" }, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("rejects a non-allowlisted internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/internal/admin/secrets")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external url with a valid-looking data prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("https://evil.example/api/v1/openclaw/data/volume-profile"),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
