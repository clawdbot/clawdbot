import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, {
  runStartAutonomousWorkflow,
  START_AUTONOMOUS_WORKFLOW_TOOL_NAME,
} from "./index.js";

describe("vctraderai-start-autonomous-workflow", () => {
  it("registers the start_autonomous_workflow tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-start-autonomous-workflow",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: START_AUTONOMOUS_WORKFLOW_TOOL_NAME,
      label: "Start Autonomous Workflow",
    });
  });

  it("returns the workflow start envelope verbatim on the happy path", async () => {
    const envelope = {
      workflow_id: "wf-7f3b2c00",
      initial_status: "queued",
      workflow_kind: "symbol_discovery",
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runStartAutonomousWorkflow(
      { workflow_kind: "symbol_discovery", params: {} },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("posts to the workflows/start path with the body verbatim", async () => {
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
    await runStartAutonomousWorkflow(
      {
        workflow_kind: "parameter_sweep",
        params: { strategy_id: "str-1", grid_size: 16 },
      },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/workflows/start");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toEqual({
      workflow_kind: "parameter_sweep",
      params: { strategy_id: "str-1", grid_size: 16 },
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runStartAutonomousWorkflow({ workflow_kind: "symbol_discovery", params: {} }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
