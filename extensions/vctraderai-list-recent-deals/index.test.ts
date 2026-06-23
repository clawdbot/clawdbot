import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runListRecentDeals, LIST_RECENT_DEALS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-recent-deals", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalAgentToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
    if (originalAgentToken === undefined) delete process.env.PFM_AGENT_TOKEN;
    else process.env.PFM_AGENT_TOKEN = originalAgentToken;
  });

  it("registers the list_recent_deals tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-recent-deals" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_RECENT_DEALS_TOOL_NAME,
      label: "List Recent Deals",
    });
  });

  it("calls the workspace-scoped read with the owner bearer", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runListRecentDeals(
      { mt5_login: 5, live_account_id: "live_account_id-x", server: "server-x", limit: 1 },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/openclaw/live/deals`,
    );
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runListRecentDeals(
        { mt5_login: 5, live_account_id: "live_account_id-x", server: "server-x", limit: 1 },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
