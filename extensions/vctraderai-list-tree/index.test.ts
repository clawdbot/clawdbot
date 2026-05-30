import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runListTree, LIST_TREE_TOOL_NAME } from "./index.js";

describe("vctraderai-list-tree", () => {
  it("registers the list_tree tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-tree" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_TREE_TOOL_NAME,
      label: "List Tree",
    });
  });

  it("returns the tree envelope verbatim on the happy path", async () => {
    const envelope = {
      base: "s3://pfm-staging-data/curated",
      items: [
        { path: "provider=dukascopy", type: "dir" },
        { path: "provider=dukascopy/instrument=EUR_USD", type: "dir" },
        { path: "provider=dukascopy/instrument=EUR_USD/timeframe=1H", type: "dir" },
      ],
      sources: ["s3://pfm-staging-data/curated"],
      filters: { path: "", max_depth: 4, pattern: null },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runListTree({}, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the tree path and forwards the root subpath as query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListTree({ root: "provider=dukascopy/instrument=EUR_USD" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/tree");
    expect(parsed.searchParams.get("root")).toBe("provider=dukascopy/instrument=EUR_USD");
  });

  it("omits root from the query string when undefined", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListTree({}, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.has("root")).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runListTree({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
