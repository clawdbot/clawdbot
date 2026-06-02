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
      challenge_id: "the5ers-100k-stage1",
      profit_target_pct: 8,
      max_drawdown_pct: 4,
      stages: [{ name: "stage1", profit_target_pct: 8 }],
      sources: ["postgres://core.prop_firm_challenges"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runBuildPropSpec({ challenge_id: "the5ers-100k-stage1" }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the BFF catalogue/prop-spec endpoint with GET and a challenge_id query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runBuildPropSpec({ challenge_id: "the5ers-100k-stage1" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/prop-spec");
    expect(parsed.searchParams.get("challenge_id")).toBe("the5ers-100k-stage1");
    expect(capturedMethod).toBe("GET");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runBuildPropSpec({ challenge_id: "the5ers-100k-stage1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
