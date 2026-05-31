import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetWorkflowStatus, GET_WORKFLOW_STATUS_TOOL_NAME } from "./index.js";

describe("vctraderai-get-workflow-status", () => {
  it("registers the get_workflow_status tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-get-workflow-status",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_WORKFLOW_STATUS_TOOL_NAME,
      label: "Get Workflow Status",
    });
  });

  it("returns the workflow status envelope verbatim on the happy path", async () => {
    const envelope = {
      workflow_id: "wf-7f3b2c00",
      status: "running",
      progress: 0.42,
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetWorkflowStatus({ workflow_id: "wf-7f3b2c00" }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the workflows status path including the path parameter", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetWorkflowStatus({ workflow_id: "wf-7f3b2c00" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/workflows/wf-7f3b2c00/status");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGetWorkflowStatus({ workflow_id: "wf-1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
