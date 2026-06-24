import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentClosePosition } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
  VCTRADERAI_BFF_TOKEN_ENV,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-agent-close-position egress allowlist", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
  });

  it("reads the headless-user owner token env, not the gateway token", () => {
    expect(VCTRADERAI_BFF_TOKEN_ENV).toBe("PFM_AGENT_TOKEN");
  });

  it("accepts the plugin's own workspace-scoped live path", () => {
    expect(`/api/v1/workspaces/${WORKSPACE_ID}/live/positions/pos-9/agent-close`).toMatch(
      VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
    );
  });

  it("every captured url on the happy path matches the workspace-scoped allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentClosePosition({ account_id: "acct-1", position_id: "pos-9" }, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("rejects a non-allowlisted internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/admin", { method: "POST", body: {} })).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects the openclaw stage surface (wrong auth cluster)", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/stage", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external URL with a valid-looking prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch(`https://evil.example.com/api/v1/workspaces/${WORKSPACE_ID}/live/positions/pos-9`),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
