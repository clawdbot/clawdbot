import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runBuildPropSpec, BUILD_PROP_SPEC_TOOL_NAME } from "./index.js";

describe("vctraderai-build-prop-spec", () => {
  it("registers the build_prop_spec tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-build-prop-spec",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: BUILD_PROP_SPEC_TOOL_NAME,
      label: "Build Prop Spec",
    });
  });

  it("returns the prop-spec envelope verbatim on the happy path", async () => {
    const envelope = {
      prop_firm_id: "the5ers",
      account_size: 100000,
      profit_target_pct: 8,
      max_drawdown_pct: 4,
      sources: ["postgres://core.prop_firm_challenges"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runBuildPropSpec(
      { prop_firm_id: "the5ers", account_size: 100000 },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the BFF prop-spec/build endpoint with POST and a JSON body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    let capturedContentType: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      const headers = init?.headers as Record<string, string> | undefined;
      capturedContentType = headers?.["content-type"] ?? null;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runBuildPropSpec({ prop_firm_id: "the5ers", account_size: 200000 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/prop-spec/build");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(JSON.parse(capturedBody)).toEqual({
      prop_firm_id: "the5ers",
      account_size: 200000,
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runBuildPropSpec({ prop_firm_id: "the5ers", account_size: 100000 }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
