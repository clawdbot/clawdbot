import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runListStopLossTypes, LIST_STOP_LOSS_TYPES_TOOL_NAME } from "./index.js";

describe("vctraderai-list-stop-loss-types", () => {
  it("registers the list_stop_loss_types tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-stop-loss-types" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_STOP_LOSS_TYPES_TOOL_NAME,
      label: "List Stop Loss Types",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      rows: [
        ["sl-1", "fixed_pips"],
        ["sl-2", "atr_based"],
      ],
      sources: ["postgres://core.stop_loss_types"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runListStopLossTypes({ fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path with no query parameters", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListStopLossTypes({ fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/stop-loss-types");
    expect(parsed.searchParams.toString()).toBe("");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runListStopLossTypes({ fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
