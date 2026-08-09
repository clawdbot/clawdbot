import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runCreateIndicator, CREATE_INDICATOR_TOOL_NAME } from "./index.js";

describe("vctraderai-create-indicator", () => {
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

  it("registers the create_indicator tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-indicator" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: CREATE_INDICATOR_TOOL_NAME,
      label: "Create Indicator",
    });
  });

  it("creates directly through the guarded registry endpoint", async () => {
    const descriptor = { indicator_id: "indicator-1", source_kind: "python_authored" };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(descriptor), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runCreateIndicator(
      {
        intent_brief: "rolling zscore",
        name: "ZScore",
        source_text: "def compute(data, params=None):\n    return data",
      },
      { fetchImpl },
    );
    expect(result).toEqual(descriptor);
  });

  it("posts authored source to the guarded registry path", async () => {
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
    await runCreateIndicator(
      {
        intent_brief: "rolling zscore",
        name: "ZScore",
        indicator_family: "statistical",
        source_text: "def compute(data, params=None):\n    return data",
      },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/registry/create-indicator");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toMatchObject({
      intent_brief: "rolling zscore",
      name: "ZScore",
      indicator_family: "statistical",
      source_text: "def compute(data, params=None):\n    return data",
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runCreateIndicator(
        { intent_brief: "x", source_text: "def compute(data, params=None):\n    return data" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
