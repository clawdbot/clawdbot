import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runSearchDataVault, SEARCH_DATA_VAULT_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-search-data-vault", () => {
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

  it("registers search_data_vault", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-search-data-vault" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: SEARCH_DATA_VAULT_TOOL_NAME });
  });

  it("reads the workspace search route with the owner token", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { datasets: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runSearchDataVault({ query: "eurusd spread", limit: 5 }, { fetchImpl, threadId: "t-7" });

    const url = new URL(request?.url ?? "");
    expect(request?.method).toBe("GET");
    expect(url.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/data-vault/search`);
    // The BFF route reads `q`, not `query`. A rename here searches for nothing
    // and the 400 would look like an empty vault.
    expect(url.searchParams.get("q")).toBe("eurusd spread");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    expect(request?.headers.get("x-openclaw-thread")).toBe("t-7");
  });

  it("omits limit entirely so the server default applies", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { datasets: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runSearchDataVault({ query: "atr" }, { fetchImpl });

    expect(new URL(request?.url ?? "").searchParams.has("limit")).toBe(false);
  });

  it("trims the query before sending it", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { datasets: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runSearchDataVault({ query: "  volume profile  " }, { fetchImpl });

    expect(new URL(request?.url ?? "").searchParams.get("q")).toBe("volume profile");
  });

  it.each(["", "   "])("refuses a blank query (%p) before opening a request", async (query) => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as typeof globalThis.fetch;

    await expect(runSearchDataVault({ query }, { fetchImpl })).rejects.toThrow("non-empty query");
  });

  it("returns an empty result set as data, not as an error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { datasets: [], dataset_count: 0 } }), {
        status: 200,
      })) as typeof globalThis.fetch;

    await expect(runSearchDataVault({ query: "nothing matches" }, { fetchImpl })).resolves.toEqual({
      data: { datasets: [], dataset_count: 0 },
    });
  });
});
