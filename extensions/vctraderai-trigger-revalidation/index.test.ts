import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runTriggerRevalidation, TRIGGER_REVALIDATION_TOOL_NAME } from "./index.js";

describe("vctraderai-trigger-revalidation", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
  });

  it("registers the trigger_revalidation tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-trigger-revalidation" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: TRIGGER_REVALIDATION_TOOL_NAME,
      label: "Trigger Revalidation",
    });
  });

  it("posts to the stage path with the staging envelope (tool_name = allowlist key)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runTriggerRevalidation({ strategy_id: "x" } as any, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("trigger_revalidation");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({ strategy_id: "x" });
    expect(typeof capturedBody.summary).toBe("string");
  });

  it("surfaces a structured error on bff 403 (tool forbidden / not propose_only)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runTriggerRevalidation({ strategy_id: "x" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
