import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const POLICY_ID = "22222222-3333-4444-5555-666666666666";
const SIGNAL_ID = "33333333-4444-5555-6666-777777777777";

type PluginSpec = {
  id: string;
  toolName: string;
  exportName: string;
  constName: string;
  params: Record<string, unknown>;
  expectedMethod: string;
  expectedPath: string;
  expectedQuery?: Record<string, string>;
  expectedBody?: Record<string, unknown>;
};

const specs: PluginSpec[] = [
  {
    id: "vctraderai-enable-heartbeat",
    toolName: "enable_heartbeat",
    exportName: "runEnableHeartbeat",
    constName: "ENABLE_HEARTBEAT_TOOL_NAME",
    params: {
      thread_id: POLICY_ID,
      account_id: "acc-1",
      cadence_seconds: 180,
      turn_timeout_seconds: 120,
      model_route_key: "heartbeat",
      instructions: "watch risk drift",
      price_symbols: ["XAUUSD"],
    },
    expectedMethod: "POST",
    expectedPath: "/api/v1/openclaw/heartbeat/enable",
    expectedBody: {
      workspace_id: WORKSPACE_ID,
      thread_id: POLICY_ID,
      account_id: "acc-1",
      cadence_seconds: 180,
      turn_timeout_seconds: 120,
      model_route_key: "heartbeat",
      instructions: "watch risk drift",
      price_symbols: ["XAUUSD"],
    },
  },
  {
    id: "vctraderai-update-heartbeat",
    toolName: "update_heartbeat",
    exportName: "runUpdateHeartbeat",
    constName: "UPDATE_HEARTBEAT_TOOL_NAME",
    params: {
      policy_id: POLICY_ID,
      cadence_seconds: 180,
      turn_timeout_seconds: 120,
      model_route_key: "heartbeat",
    },
    expectedMethod: "POST",
    expectedPath: "/api/v1/openclaw/heartbeat/update",
    expectedBody: {
      workspace_id: WORKSPACE_ID,
      policy_id: POLICY_ID,
      cadence_seconds: 180,
      turn_timeout_seconds: 120,
      model_route_key: "heartbeat",
    },
  },
  {
    id: "vctraderai-heartbeat-now",
    toolName: "heartbeat_now",
    exportName: "runHeartbeatNow",
    constName: "HEARTBEAT_NOW_TOOL_NAME",
    params: { policy_id: POLICY_ID },
    expectedMethod: "POST",
    expectedPath: "/api/v1/openclaw/heartbeat/now",
    expectedBody: { workspace_id: WORKSPACE_ID, policy_id: POLICY_ID },
  },
  {
    id: "vctraderai-stop-heartbeat",
    toolName: "stop_heartbeat",
    exportName: "runStopHeartbeat",
    constName: "STOP_HEARTBEAT_TOOL_NAME",
    params: { policy_id: POLICY_ID },
    expectedMethod: "POST",
    expectedPath: "/api/v1/openclaw/heartbeat/stop",
    expectedBody: { workspace_id: WORKSPACE_ID, policy_id: POLICY_ID },
  },
  {
    id: "vctraderai-get-heartbeat-status",
    toolName: "get_heartbeat_status",
    exportName: "runGetHeartbeatStatus",
    constName: "GET_HEARTBEAT_STATUS_TOOL_NAME",
    params: { policy_id: POLICY_ID },
    expectedMethod: "GET",
    expectedPath: "/api/v1/openclaw/heartbeat/status",
    expectedQuery: { workspace_id: WORKSPACE_ID, policy_id: POLICY_ID },
  },
  {
    id: "vctraderai-get-model-routes",
    toolName: "get_model_routes",
    exportName: "runGetModelRoutes",
    constName: "GET_MODEL_ROUTES_TOOL_NAME",
    params: {},
    expectedMethod: "GET",
    expectedPath: "/api/v1/openclaw/model-routes",
    expectedQuery: { workspace_id: WORKSPACE_ID },
  },
  {
    id: "vctraderai-recommend-model-routes",
    toolName: "recommend_model_routes",
    exportName: "runRecommendModelRoutes",
    constName: "RECOMMEND_MODEL_ROUTES_TOOL_NAME",
    params: {},
    expectedMethod: "GET",
    expectedPath: "/api/v1/openclaw/model-routes/recommendations",
    expectedQuery: { workspace_id: WORKSPACE_ID },
  },
  {
    id: "vctraderai-set-model-route",
    toolName: "set_model_route",
    exportName: "runSetModelRoute",
    constName: "SET_MODEL_ROUTE_TOOL_NAME",
    params: {
      route_key: "heartbeat",
      model_id: "google/gemini-2.5-flash",
      fallback_models: ["deepseek/deepseek-v4-flash"],
      enabled: true,
    },
    expectedMethod: "POST",
    expectedPath: "/api/v1/openclaw/model-routes/set",
    expectedBody: {
      workspace_id: WORKSPACE_ID,
      route_key: "heartbeat",
      model_id: "google/gemini-2.5-flash",
      fallback_models: ["deepseek/deepseek-v4-flash"],
      enabled: true,
    },
  },
  {
    id: "vctraderai-emit-specialist-signal",
    toolName: "emit_specialist_signal",
    exportName: "runEmitSpecialistSignal",
    constName: "EMIT_SPECIALIST_SIGNAL_TOOL_NAME",
    params: {
      specialist_key: "gold_specialist",
      route_key: "gold_specialist",
      instrument: "XAUUSD",
      topic: "gold open",
      thesis: "Gold risk is headline-driven.",
      confidence: 0.62,
      horizon: "intraday",
      evidence: { source: "web_news_search" },
      source_urls: ["https://example.com/gold"],
    },
    expectedMethod: "POST",
    expectedPath: "/api/v1/openclaw/signals/emit",
    expectedBody: {
      workspace_id: WORKSPACE_ID,
      specialist_key: "gold_specialist",
      route_key: "gold_specialist",
      instrument: "XAUUSD",
      topic: "gold open",
      thesis: "Gold risk is headline-driven.",
      confidence: 0.62,
      horizon: "intraday",
      evidence: { source: "web_news_search" },
      source_urls: ["https://example.com/gold"],
    },
  },
  {
    id: "vctraderai-list-agent-signals",
    toolName: "list_agent_signals",
    exportName: "runListAgentSignals",
    constName: "LIST_AGENT_SIGNALS_TOOL_NAME",
    params: { status: "new" },
    expectedMethod: "GET",
    expectedPath: "/api/v1/openclaw/signals",
    expectedQuery: { workspace_id: WORKSPACE_ID, status: "new" },
  },
  {
    id: "vctraderai-read-agent-signal",
    toolName: "read_agent_signal",
    exportName: "runReadAgentSignal",
    constName: "READ_AGENT_SIGNAL_TOOL_NAME",
    params: { signal_id: SIGNAL_ID },
    expectedMethod: "GET",
    expectedPath: `/api/v1/openclaw/signals/${SIGNAL_ID}`,
    expectedQuery: { workspace_id: WORKSPACE_ID },
  },
  {
    id: "vctraderai-consume-agent-signal",
    toolName: "consume_agent_signal",
    exportName: "runConsumeAgentSignal",
    constName: "CONSUME_AGENT_SIGNAL_TOOL_NAME",
    params: {
      signal_id: SIGNAL_ID,
      consumed_by_thread_id: POLICY_ID,
    },
    expectedMethod: "POST",
    expectedPath: "/api/v1/openclaw/signals/consume",
    expectedBody: {
      workspace_id: WORKSPACE_ID,
      signal_id: SIGNAL_ID,
      consumed_by_thread_id: POLICY_ID,
    },
  },
  {
    id: "vctraderai-generate-pre-session-briefing",
    toolName: "generate_pre_session_briefing",
    exportName: "runGeneratePreSessionBriefing",
    constName: "GENERATE_PRE_SESSION_BRIEFING_TOOL_NAME",
    params: { session: "LDN", instrument: "XAUUSD" },
    expectedMethod: "GET",
    expectedPath: "/api/v1/openclaw/briefings/pre-session",
    expectedQuery: { workspace_id: WORKSPACE_ID, session: "LDN", instrument: "XAUUSD" },
  },
  {
    id: "vctraderai-generate-day-ahead-forecast",
    toolName: "generate_day_ahead_forecast",
    exportName: "runGenerateDayAheadForecast",
    constName: "GENERATE_DAY_AHEAD_FORECAST_TOOL_NAME",
    params: { instrument: "XAUUSD" },
    expectedMethod: "GET",
    expectedPath: "/api/v1/openclaw/briefings/day-ahead",
    expectedQuery: { workspace_id: WORKSPACE_ID, instrument: "XAUUSD" },
  },
  {
    id: "vctraderai-generate-session-summary",
    toolName: "generate_session_summary",
    exportName: "runGenerateSessionSummary",
    constName: "GENERATE_SESSION_SUMMARY_TOOL_NAME",
    params: { session: "NY", instrument: "XAUUSD" },
    expectedMethod: "GET",
    expectedPath: "/api/v1/openclaw/briefings/session-summary",
    expectedQuery: { workspace_id: WORKSPACE_ID, session: "NY", instrument: "XAUUSD" },
  },
];

const pluginModules = import.meta.glob("./vctraderai-*/index.ts", { eager: true });

describe("Agent Alpha heartbeat and Session D vctraderai plugins", () => {
  const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalWorkspaceId = process.env.PFM_WORKSPACE_ID;

  beforeEach(() => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-001";
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
    if (originalWorkspaceId === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  it.each(specs)("$id registers $toolName and calls the guarded BFF endpoint", async (spec) => {
    const mod = pluginModules[`./${spec.id}/index.ts`] as Record<string, any> | undefined;
    expect(mod, `${spec.id} module must be importable`).toBeDefined();
    if (mod === undefined) {
      return;
    }
    expect(mod[spec.constName]).toBe(spec.toolName);

    const captured = createCapturedPluginRegistration({ id: spec.id });
    mod.default.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0].name).toBe(spec.toolName);
    const parameterProperties =
      (captured.tools[0].parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(parameterProperties).not.toHaveProperty("workspace_id");

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth: string | null = null;
    let capturedTool: string | null = null;
    let capturedBody: unknown = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      capturedTool = headers.get("x-openclaw-tool");
      capturedBody = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await mod[spec.exportName](spec.params, { fetchImpl });

    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(spec.expectedPath);
    expect(capturedMethod).toBe(spec.expectedMethod);
    expect(capturedAuth).toBe("Bearer gateway-token-001");
    expect(capturedTool).toBe(spec.toolName);

    for (const [key, value] of Object.entries(spec.expectedQuery ?? {})) {
      expect(parsed.searchParams.get(key)).toBe(value);
    }
    if (spec.expectedBody !== undefined) {
      expect(capturedBody).toEqual(spec.expectedBody);
    }
  });
});
