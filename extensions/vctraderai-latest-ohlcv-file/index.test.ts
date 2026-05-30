import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runLatestOhlcvFile, LATEST_OHLCV_FILE_TOOL_NAME } from "./index.js";

describe("vctraderai-latest-ohlcv-file", () => {
  it("registers the latest_ohlcv_file tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-latest-ohlcv-file" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LATEST_OHLCV_FILE_TOOL_NAME,
      label: "Latest OHLCV File",
    });
  });

  it("returns the latest-file envelope verbatim on the happy path", async () => {
    const envelope = {
      path: "s3://pfm-staging-data/curated/provider=dukascopy/instrument=EUR_USD/timeframe=1H/year=2026/month=05/day=29/part.parquet",
      sources: [
        "s3://pfm-staging-data/curated/provider=dukascopy/instrument=EUR_USD/timeframe=1H/year=2026/month=05/day=29/part.parquet",
      ],
      filters: { instrument: "EUR_USD", timeframe: "1H", provider: "dukascopy" },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runLatestOhlcvFile(
      { symbol: "EUR_USD", tf: "1H", provider: "dukascopy" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the ohlcv/latest path and forwards required params as query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runLatestOhlcvFile({ symbol: "EUR_USD", tf: "1H", provider: "dukascopy" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/ohlcv/latest");
    expect(parsed.searchParams.get("symbol")).toBe("EUR_USD");
    expect(parsed.searchParams.get("tf")).toBe("1H");
    expect(parsed.searchParams.get("provider")).toBe("dukascopy");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runLatestOhlcvFile({ symbol: "EUR_USD", tf: "1H" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
