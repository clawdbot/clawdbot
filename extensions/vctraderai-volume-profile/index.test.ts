import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runVolumeProfile, VOLUME_PROFILE_TOOL_NAME } from "./index.js";

describe("vctraderai-volume-profile", () => {
  it("registers the volume_profile tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-volume-profile" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: VOLUME_PROFILE_TOOL_NAME,
      label: "Volume Profile",
    });
  });

  it("calls the data-cluster volume-profile endpoint with mapped query params", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runVolumeProfile({ symbol: "EUR_USD", tf: "4h", window: 120, n_bins: 30 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/volume-profile");
    expect(parsed.searchParams.get("symbol")).toBe("EUR_USD");
    expect(parsed.searchParams.get("tf")).toBe("4h");
    expect(parsed.searchParams.get("window")).toBe("120");
    expect(parsed.searchParams.get("n_bins")).toBe("30");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", {
        status: 422,
        statusText: "Unprocessable Entity",
      })) as typeof globalThis.fetch;
    await expect(runVolumeProfile({ symbol: "EUR_USD" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_422", status: 422 },
    });
  });
});
