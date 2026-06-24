import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runModifyPositionProtection,
  MODIFY_POSITION_PROTECTION_TOOL_NAME,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-modify-position-protection", () => {
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

  it("registers the modify_position_protection tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-modify-position-protection",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: MODIFY_POSITION_PROTECTION_TOOL_NAME,
      label: "Modify Position Protection",
    });
  });

  it("posts to the workspace-scoped agent-protection path with the owner bearer + body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth: string | null = null;
    let capturedBody: any = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedAuth = new Headers(init?.headers).get("authorization");
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ executed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const result = await runModifyPositionProtection(
      { account_id: "acct-1", position_id: "pos-9", sl: 1.2345, tp: 1.4567 },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/live/positions/pos-9/agent-protection`,
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({ account_id: "acct-1", sl: 1.2345, tp: 1.4567 });
    expect(result).toEqual({ executed: true });
  });

  it("omits sl/tp from the body when undefined", async () => {
    let capturedBody: any = undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ downgraded_to_staged: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runModifyPositionProtection(
      { account_id: "acct-1", position_id: "pos-9" },
      { fetchImpl },
    );
    expect(capturedBody).toEqual({ account_id: "acct-1" });
    expect("sl" in capturedBody).toBe(false);
    expect("tp" in capturedBody).toBe(false);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runModifyPositionProtection({ account_id: "acct-1", position_id: "pos-9" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
