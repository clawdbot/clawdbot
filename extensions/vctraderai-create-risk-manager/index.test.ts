import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runCreateRiskManager, CREATE_RISK_MANAGER_TOOL_NAME } from "./index.js";

describe("vctraderai-create-risk-manager", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  it("registers the create_risk_manager tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-risk-manager" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: CREATE_RISK_MANAGER_TOOL_NAME,
      label: "Create Risk Manager",
    });
  });

  it("stages the proposal and wraps the descriptor with a review message", async () => {
    const descriptor = { staged_id: "stg-4", tool_name: "create_risk_manager", status: "staged" };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(descriptor), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runCreateRiskManager(
      { name: "Conservative", max_dd_pct: 5 },
      { fetchImpl },
    );
    expect(result).toMatchObject({
      staged: descriptor,
      message: "Staged a new risk-manager proposal. Review + Apply it in the chat.",
    });
  });

  it("posts to the stage path with the staging envelope", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runCreateRiskManager(
      { name: "Conservative", max_dd_pct: 5, risk_per_trade_pct: 0.5 },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toMatchObject({
      tool_name: "create_risk_manager",
      workspace_id: "ws-001",
      summary: "Create Conservative",
      params: { name: "Conservative", max_dd_pct: 5, risk_per_trade_pct: 0.5 },
    });
  });

  it("includes the intent_brief in the summary when provided", async () => {
    let capturedBody: { summary?: string } = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runCreateRiskManager(
      { name: "Aggressive", intent_brief: "high turnover" },
      { fetchImpl },
    );
    expect(capturedBody.summary).toBe("Create Aggressive: high turnover");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runCreateRiskManager({ name: "RM" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
