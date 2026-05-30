import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runListTimeframes, LIST_TIMEFRAMES_TOOL_NAME } from "./index.js";

describe("vctraderai-list-timeframes", () => {
  it("registers the list_timeframes tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-timeframes" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_TIMEFRAMES_TOOL_NAME,
      label: "List Timeframes",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      rows: [
        ["tf-1", "1H", 3600],
        ["tf-2", "1D", 86400],
      ],
      sources: ["postgres://core.timeframes"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runListTimeframes({ limit: 10 }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path and forwards query params as strings", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListTimeframes({ limit: 25 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/timeframes");
    expect(parsed.searchParams.get("limit")).toBe("25");
  });

  it("omits undefined query params from the query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListTimeframes({}, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/timeframes");
    expect(parsed.searchParams.has("limit")).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runListTimeframes({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
