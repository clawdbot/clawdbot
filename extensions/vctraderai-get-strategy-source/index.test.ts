import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetStrategySource, GET_STRATEGY_SOURCE_TOOL_NAME } from "./index.js";

describe("vctraderai-get-strategy-source", () => {
  it("registers the get_strategy_source tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-strategy-source" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_STRATEGY_SOURCE_TOOL_NAME,
      label: "Get Strategy Source",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      strategy_id: "str-1",
      source: "def strategy(...): ...",
      sources: ["postgres://core.strategies"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetStrategySource({ strategy_id: "str-1" }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path including the path parameter", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetStrategySource({ strategy_id: "str-1" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/strategies/str-1/source");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGetStrategySource({ strategy_id: "str-1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
