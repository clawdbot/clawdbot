import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runPropRuleHeadroom,
  PROP_RULE_HEADROOM_TOOL_NAME,
  type PropRuleHeadroomParams,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-prop-rule-headroom", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalAgentToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
    if (originalAgentToken === undefined) {
      delete process.env.PFM_AGENT_TOKEN;
    } else {
      process.env.PFM_AGENT_TOKEN = originalAgentToken;
    }
  });

  it("registers the prop_rule_headroom tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-prop-rule-headroom" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: PROP_RULE_HEADROOM_TOOL_NAME,
      label: "Prop Rule Headroom",
    });
  });

  it("POSTs a JSON body to the workspace-scoped risk/prop-headroom endpoint", async () => {
    let capturedUrl = "";
    let capturedMethod = "GET";
    let capturedAuth: string | null = null;
    let capturedContentType: string | null = null;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      capturedContentType = headers.get("content-type");
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(
        JSON.stringify({ profit_target_room: 1000, max_dd_room: 2000, daily_loss_room: 500 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;
    await runPropRuleHeadroom({ variant_id: "variant-1", account_size: 100000 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/risk/prop-headroom`);
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toEqual({ variant_id: "variant-1", account_size: 100000 });
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("requires variant_id and account_size", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(
      runPropRuleHeadroom({ variant_id: "", account_size: 100000 }, { fetchImpl }),
    ).rejects.toThrow(/variant_id is required/);
    await expect(
      runPropRuleHeadroom({ variant_id: "variant-1" } as PropRuleHeadroomParams, { fetchImpl }),
    ).rejects.toThrow(/account_size is required/);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", {
        status: 400,
        statusText: "Bad Request",
      })) as typeof globalThis.fetch;
    await expect(
      runPropRuleHeadroom({ variant_id: "variant-1", account_size: 100000 }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_400", status: 400 },
    });
  });
});
