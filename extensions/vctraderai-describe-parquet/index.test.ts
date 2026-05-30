import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runDescribeParquet, DESCRIBE_PARQUET_TOOL_NAME } from "./index.js";

describe("vctraderai-describe-parquet", () => {
  it("registers the describe_parquet tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-describe-parquet" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: DESCRIBE_PARQUET_TOOL_NAME,
      label: "Describe Parquet",
    });
  });

  it("returns the describe envelope verbatim on the happy path", async () => {
    const envelope = {
      path: "s3://pfm-staging-data/curated/.../part.parquet",
      schema: [
        { name: "timestamp", type: "timestamp[us]" },
        { name: "open", type: "double" },
        { name: "high", type: "double" },
        { name: "low", type: "double" },
        { name: "close", type: "double" },
        { name: "volume", type: "double" },
      ],
      num_row_groups: 4,
      row_count_estimate: 1440,
      modified_time: "2026-05-29T12:00:00Z",
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runDescribeParquet(
      { path: "s3://pfm-staging-data/curated/.../part.parquet" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the parquet/describe path and forwards the required path param", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runDescribeParquet({ path: "dukascopy/EUR_USD/1H/2026/05/29.parquet" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/parquet/describe");
    expect(parsed.searchParams.get("path")).toBe("dukascopy/EUR_USD/1H/2026/05/29.parquet");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runDescribeParquet({ path: "x.parquet" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
