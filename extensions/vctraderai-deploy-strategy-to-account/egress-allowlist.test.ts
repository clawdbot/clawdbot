import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDeployStrategyToAccount } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
  VCTRADERAI_BFF_TOKEN_ENV,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-deploy-strategy-to-account egress allowlist", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
    if (originalToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
  });

  it("reads the SHARED gateway token env, not the per-workspace owner token", () => {
    // The /api/v1/openclaw/* propose cluster authenticates server-to-server.
    // The workspace-scoped Data Vault plugins use PFM_AGENT_TOKEN instead; the
    // two clusters are not interchangeable and a swap is a 401.
    expect(VCTRADERAI_BFF_TOKEN_ENV).toBe("OPENCLAW_GATEWAY_TOKEN");
  });

  it("the stage path is permitted by the allowlist", () => {
    expect("/api/v1/openclaw/stage").toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
  });

  it("every captured url on the happy path matches the allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 201 });
    }) as typeof globalThis.fetch;

    await runDeployStrategyToAccount(
      { strategy_id: "s", version_id: "v", account_id: "a" },
      { fetchImpl },
    );

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

  it("rejects traversal outside the permitted openclaw surface", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/openclaw/../../admin")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
