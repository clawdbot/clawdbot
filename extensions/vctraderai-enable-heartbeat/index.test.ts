import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { ENABLE_HEARTBEAT_TOOL_NAME, runEnableHeartbeat } from "./index.js";

describe("vctraderai-enable-heartbeat", () => {
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

  function schema(): any {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-enable-heartbeat" });
    plugin.register(captured.api);
    return captured.tools[0].parameters as any;
  }

  it("registers the enable_heartbeat tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-enable-heartbeat" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: ENABLE_HEARTBEAT_TOOL_NAME });
  });

  // Accounts went 0..N via a join table in propfirm_manager #1347. The BFF
  // route has only ever read `account_ids`; the singular `account_id` this
  // schema advertised was silently dropped on every call.
  it("exposes account_ids as an OPTIONAL list, not a required singular account_id", () => {
    const parameters = schema();
    expect(parameters.properties.account_id).toBeUndefined();
    const accountIds = parameters.properties.account_ids;
    expect(accountIds).toBeDefined();
    const asArray = accountIds.type === "array" ? accountIds : accountIds.anyOf?.[0];
    expect(asArray?.type).toBe("array");
    expect(parameters.required ?? []).not.toContain("account_ids");
    expect(parameters.required ?? []).not.toContain("account_id");
  });

  it("still requires cadence_seconds", () => {
    expect(schema().required ?? []).toContain("cadence_seconds");
  });

  it("posts account_ids through to the guarded heartbeat route", async () => {
    let capturedUrl = "";
    let capturedBody: any;
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ policy_id: "pol-1", status: "active" }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    await runEnableHeartbeat(
      { cadence_seconds: 300, account_ids: ["acc-1", "acc-2"] },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/heartbeat/enable");
    expect(capturedHeaders["x-openclaw-tool"]).toBe("enable_heartbeat");
    expect(capturedBody).toMatchObject({
      cadence_seconds: 300,
      account_ids: ["acc-1", "acc-2"],
      workspace_id: "ws-001",
    });
  });

  it("can request an account-independent heartbeat with no accounts at all", async () => {
    let capturedBody: any;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ policy_id: "pol-2", status: "active" }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    await runEnableHeartbeat({ cadence_seconds: 900 }, { fetchImpl });
    expect(capturedBody.account_ids).toBeUndefined();
    expect(capturedBody.cadence_seconds).toBe(900);
  });
});
