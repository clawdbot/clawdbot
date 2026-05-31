import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGenerateDailyReport, GENERATE_DAILY_REPORT_TOOL_NAME } from "./index.js";

describe("vctraderai-generate-daily-report", () => {
  it("registers the generate_daily_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-daily-report",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GENERATE_DAILY_REPORT_TOOL_NAME,
      label: "Generate Daily Report",
    });
  });

  it("returns the report envelope verbatim on the happy path", async () => {
    const envelope = {
      workspace_id: "11111111-1111-1111-1111-111111111111",
      day: "2026-05-30",
      pnl: { realized: 123.45, unrealized: 0 },
      sources: ["postgres://live.trade_fills"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGenerateDailyReport(
      { workspace_id: "11111111-1111-1111-1111-111111111111" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the BFF reports/daily endpoint with POST and a JSON body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    let capturedContentType: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      const headers = init?.headers as Record<string, string> | undefined;
      capturedContentType = headers?.["content-type"] ?? null;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGenerateDailyReport(
      { workspace_id: "11111111-1111-1111-1111-111111111111", day: "2026-05-30" },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/reports/daily");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "11111111-1111-1111-1111-111111111111",
      day: "2026-05-30",
    });
  });

  it("omits the day field from the body when not provided", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGenerateDailyReport(
      { workspace_id: "11111111-1111-1111-1111-111111111111" },
      { fetchImpl },
    );
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGenerateDailyReport(
        { workspace_id: "11111111-1111-1111-1111-111111111111" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
