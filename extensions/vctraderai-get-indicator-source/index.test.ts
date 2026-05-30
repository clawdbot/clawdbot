import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetIndicatorSource, GET_INDICATOR_SOURCE_TOOL_NAME } from "./index.js";

describe("vctraderai-get-indicator-source", () => {
  it("registers the get_indicator_source tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-indicator-source" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_INDICATOR_SOURCE_TOOL_NAME,
      label: "Get Indicator Source",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      indicator_id: "ind-1",
      source: "def indicator(...): ...",
      sources: ["postgres://core.indicators"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetIndicatorSource({ indicator_id: "ind-1" }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path including the path parameter", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetIndicatorSource({ indicator_id: "ind-1" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/indicators/ind-1/source");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGetIndicatorSource({ indicator_id: "ind-1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
