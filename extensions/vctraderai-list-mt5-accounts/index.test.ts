import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { runListMt5Accounts, LIST_MT5_ACCOUNTS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-mt5-accounts", () => {
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

  it("registers the list_mt5_accounts tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-mt5-accounts" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_MT5_ACCOUNTS_TOOL_NAME,
      label: "List MT5 Accounts",
    });
  });

  it("calls the workspace-scoped live accounts read with the owner bearer", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      return new Response(JSON.stringify({ data: { accounts: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runListMt5Accounts({ limit: 25 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/openclaw/live/accounts`);
    expect(parsed.searchParams.get("limit")).toBe("25");
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(runListMt5Accounts({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });

  it("aborts when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(runListMt5Accounts({}, { fetchImpl }, controller.signal)).rejects.toThrow();
  });
});
