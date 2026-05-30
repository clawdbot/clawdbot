import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runListPropFirmChallenges, LIST_PROP_FIRM_CHALLENGES_TOOL_NAME } from "./index.js";

describe("vctraderai-list-prop-firm-challenges", () => {
  it("registers the list_prop_firm_challenges tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-list-prop-firm-challenges",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_PROP_FIRM_CHALLENGES_TOOL_NAME,
      label: "List Prop-Firm Challenges",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      rows: [
        ["pfc-1", "the5ers_100k"],
        ["pfc-2", "ic_markets_25k"],
      ],
      sources: ["postgres://core.prop_firm_challenges"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runListPropFirmChallenges({ limit: 10 }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path and forwards query params as strings", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListPropFirmChallenges({ limit: 25 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/prop-firm-challenges");
    expect(parsed.searchParams.get("limit")).toBe("25");
  });

  it("omits undefined query params from the query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListPropFirmChallenges({}, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/prop-firm-challenges");
    expect(parsed.searchParams.has("limit")).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runListPropFirmChallenges({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
