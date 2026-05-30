import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetCoverage, GET_COVERAGE_TOOL_NAME } from "./index.js";

describe("vctraderai-get-coverage", () => {
  it("registers the get_coverage tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-coverage" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_COVERAGE_TOOL_NAME,
      label: "Get Coverage",
    });
  });

  it("returns the coverage envelope verbatim on the happy path", async () => {
    const envelope = {
      instrument: "EUR_USD",
      provider: "dukascopy",
      timeframes: {
        "1H": { files: 120, date_start: "2025-01-01", date_end: "2026-05-29" },
        "1D": { files: 6, date_start: "2025-01-01", date_end: "2026-05-29" },
      },
      sources: [],
      filters: { instrument: "EUR_USD", provider: "dukascopy" },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetCoverage(
      { symbol: "EUR_USD", provider: "dukascopy" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the coverage path and forwards filter params as query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetCoverage({ symbol: "EUR_USD", provider: "dukascopy", tf: "1H" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/coverage");
    expect(parsed.searchParams.get("symbol")).toBe("EUR_USD");
    expect(parsed.searchParams.get("provider")).toBe("dukascopy");
    expect(parsed.searchParams.get("tf")).toBe("1H");
  });

  it("omits undefined params from the query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetCoverage({ symbol: "EUR_USD" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("symbol")).toBe("EUR_USD");
    expect(parsed.searchParams.has("provider")).toBe(false);
    expect(parsed.searchParams.has("tf")).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runGetCoverage({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
