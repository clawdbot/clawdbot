import { describe, expect, it, vi } from "vitest";
import { runAccountState } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

function recordingFetch(): {
  fetchImpl: typeof globalThis.fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetchImpl, urls };
}

describe("vctraderai-account-state egress allowlist", () => {
  it("every captured url on the happy path matches the workspace-scoped allowlist", async () => {
    const { fetchImpl, urls } = recordingFetch();
    await runAccountState(WORKSPACE_ID, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const path = new URL(url).pathname;
      expect(path).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("rejects a non-allowlisted internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/internal/admin/secrets")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external url even if the path-shape matches a workspace prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch(`https://evil.example/api/v1/workspaces/${WORKSPACE_ID}/dashboard/home`),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects path with workspace prefix but no trailing segment", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch(`/api/v1/workspaces/${WORKSPACE_ID}/`)).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects path with non-hex workspace segment", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/workspaces/NOT-A-VALID-UUID-zzz/dashboard/home"),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
