import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runGenerateReport, GENERATE_REPORT_TOOL_NAME } from "./index.js";

describe("vctraderai-generate-report", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
  });

  it("registers the generate_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-generate-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GENERATE_REPORT_TOOL_NAME,
      label: "Generate Report",
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
    await runGenerateReport({ report_type: "x" } as any, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("generate_report");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({ report_type: "x" });
    expect(typeof capturedBody.summary).toBe("string");
  });

  it("surfaces a structured error on bff 403 (tool forbidden / not propose_only)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runGenerateReport({ report_type: "x" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
