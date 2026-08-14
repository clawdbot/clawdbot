import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGetDataVaultDataset } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_DATA_VAULT_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-get-data-vault-dataset egress allowlist", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
    if (originalToken === undefined) delete process.env.PFM_AGENT_TOKEN;
    else process.env.PFM_AGENT_TOKEN = originalToken;
  });

  it("every captured url on the happy path matches the workspace-scoped allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runGetDataVaultDataset({ name: "signals", rows: 10 }, { fetchImpl });

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_DATA_VAULT_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("refuses a traversal dataset name outright rather than smuggling it through", async () => {
    // encodeURIComponent turns "../../admin" into "..%2F..%2Fadmin", which the
    // allowlist regex alone would accept as one path segment. The literal "/.."
    // guard is what stops it, and it must keep firing: refuse loudly (DEC-30)
    // instead of quietly issuing a request built from a traversal name.
    const fetchImpl = vi.fn();

    await expect(
      runGetDataVaultDataset(
        { name: "../../admin" },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/internal/admin/secrets")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects sibling workspace-scoped surfaces outside the data vault", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch(`/api/v1/workspaces/${WORKSPACE_ID}/accounts`)).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects the openclaw data/catalogue surfaces (wrong auth cluster)", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/openclaw/data/ohlcv/tail")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
