import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runGetSituationalAwareness,
  GET_SITUATIONAL_AWARENESS_TOOL_NAME,
} from "./index.js";

const WORKSPACE_ID = "6c9176ed-88b4-404f-8b51-70cd63cdeeff";

describe("vctraderai-get-situational-awareness", () => {
  let priorWorkspaceId: string | undefined;

  beforeEach(() => {
    priorWorkspaceId = process.env.PFM_WORKSPACE_ID;
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  });

  afterEach(() => {
    if (priorWorkspaceId === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = priorWorkspaceId;
    }
  });

  it("registers the get_situational_awareness tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-get-situational-awareness",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_SITUATIONAL_AWARENESS_TOOL_NAME,
      label: "Get Situational Awareness",
    });
  });

  it("returns the situational-awareness snapshot verbatim on the happy path", async () => {
    const snapshot = {
      risk_budget: { used_pct: 12.5, remaining_pct: 87.5 },
      regime: "trend_up",
      econ_proximity: { next_high_impact_minutes: 45 },
      account_health: { status: "healthy" },
      honesty: { offline_mode: true, metaapi_used: false },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetSituationalAwareness({}, { fetchImpl });
    expect(result).toEqual(snapshot);
  });

  it("calls the situational-awareness path and forwards workspace + params + tool header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedInit = init;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSituationalAwareness({ account_id: "acc-1", instrument: "XAUUSD" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/situational-awareness");
    expect(parsed.searchParams.get("workspace_id")).toBe(WORKSPACE_ID);
    expect(parsed.searchParams.get("account_id")).toBe("acc-1");
    expect(parsed.searchParams.get("instrument")).toBe("XAUUSD");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-openclaw-tool")).toBe(GET_SITUATIONAL_AWARENESS_TOOL_NAME);
  });

  it("omits undefined optional params from the query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSituationalAwareness({}, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("workspace_id")).toBe(WORKSPACE_ID);
    expect(parsed.searchParams.has("account_id")).toBe(false);
    expect(parsed.searchParams.has("instrument")).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runGetSituationalAwareness({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  it("throws when PFM_WORKSPACE_ID is not set", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runGetSituationalAwareness({}, { fetchImpl })).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
