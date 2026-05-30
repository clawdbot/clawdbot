import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runOhlcvTail, OHLCV_TAIL_TOOL_NAME } from "./index.js";

describe("vctraderai-ohlcv-tail", () => {
  it("registers the ohlcv_tail tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-ohlcv-tail" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: OHLCV_TAIL_TOOL_NAME,
      label: "OHLCV Tail",
    });
  });

  it("returns the ohlcv-tail envelope verbatim on the happy path", async () => {
    const envelope = {
      path: "s3://pfm-staging-data/curated/.../part.parquet",
      rows: [
        { timestamp: "2026-05-29T11:00:00Z", open: 1.08, high: 1.082, low: 1.079, close: 1.081 },
        { timestamp: "2026-05-29T12:00:00Z", open: 1.081, high: 1.083, low: 1.08, close: 1.082 },
      ],
      schema: [
        { name: "timestamp", type: "timestamp[us]" },
        { name: "open", type: "double" },
        { name: "high", type: "double" },
        { name: "low", type: "double" },
        { name: "close", type: "double" },
      ],
      source: "s3://pfm-staging-data/curated/.../part.parquet",
      filters: { instrument: "EUR_USD", timeframe: "1H", n: 2, provider: "dukascopy" },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runOhlcvTail(
      { symbol: "EUR_USD", tf: "1H", n: 2, provider: "dukascopy" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("forwards symbol + tf + n + provider to the ohlcv/tail endpoint as query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runOhlcvTail({ symbol: "EUR_USD", tf: "1H", n: 5, provider: "dukascopy" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/ohlcv/tail");
    expect(parsed.searchParams.get("symbol")).toBe("EUR_USD");
    expect(parsed.searchParams.get("tf")).toBe("1H");
    expect(parsed.searchParams.get("n")).toBe("5");
    expect(parsed.searchParams.get("provider")).toBe("dukascopy");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runOhlcvTail({ symbol: "EUR_USD", tf: "1H", n: 5 }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
