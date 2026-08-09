import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runUpdateStrategy, UPDATE_STRATEGY_TOOL_NAME } from "./index.js";

describe("vctraderai-update-strategy", () => {
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

  it("registers the update_strategy tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-update-strategy" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: UPDATE_STRATEGY_TOOL_NAME,
      label: "Update Strategy",
    });
  });

  it("updates directly through the guarded registry endpoint", async () => {
    const descriptor = { strategy_id: "str-9", version: 2 };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(descriptor), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runUpdateStrategy(
      { strategy_id: "str-9", intent_brief: "widen stop" },
      { fetchImpl },
    );
    expect(result).toEqual(descriptor);
  });

  it("posts the update to the guarded registry path", async () => {
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
    await runUpdateStrategy(
      { strategy_id: "str-9", intent_brief: "widen stop", timeframes: ["H1"] },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/registry/update-strategy");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toMatchObject({
      strategy_id: "str-9",
      intent_brief: "widen stop",
      timeframes: ["H1"],
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runUpdateStrategy({ strategy_id: "str-9" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
