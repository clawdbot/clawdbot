import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runParquetPreviewTail, PARQUET_PREVIEW_TAIL_TOOL_NAME } from "./index.js";

describe("vctraderai-parquet-preview-tail", () => {
  it("registers the parquet_preview_tail tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-parquet-preview-tail" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: PARQUET_PREVIEW_TAIL_TOOL_NAME,
      label: "Parquet Preview Tail",
    });
  });

  it("returns the preview envelope verbatim on the happy path", async () => {
    const envelope = {
      path: "x.parquet",
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
      row_group: 3,
      sources: ["x.parquet"],
      filters: { path: "x.parquet", n: 2 },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runParquetPreviewTail({ path: "x.parquet", n: 2 }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("forwards path + n to the preview-tail endpoint as query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runParquetPreviewTail({ path: "x.parquet", n: 5 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/parquet/preview-tail");
    expect(parsed.searchParams.get("path")).toBe("x.parquet");
    expect(parsed.searchParams.get("n")).toBe("5");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runParquetPreviewTail({ path: "x.parquet", n: 5 }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
