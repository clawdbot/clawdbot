import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGenerateWeeklyReport, GENERATE_WEEKLY_REPORT_TOOL_NAME } from "./index.js";

describe("vctraderai-generate-weekly-report", () => {
  it("registers the generate_weekly_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-weekly-report",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GENERATE_WEEKLY_REPORT_TOOL_NAME,
      label: "Generate Weekly Report",
    });
  });

  it("returns the report envelope verbatim on the happy path", async () => {
    const envelope = {
      workspace_id: "22222222-2222-2222-2222-222222222222",
      week_ending: "2026-05-30",
      pnl: { realized: 980.55, unrealized: 12.0 },
      sources: ["postgres://live.trade_fills"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGenerateWeeklyReport(
      { workspace_id: "22222222-2222-2222-2222-222222222222" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the BFF reports/weekly endpoint with POST and a JSON body", async () => {
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
    await runGenerateWeeklyReport(
      { workspace_id: "22222222-2222-2222-2222-222222222222", week_ending: "2026-05-30" },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/reports/weekly");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "22222222-2222-2222-2222-222222222222",
      week_ending: "2026-05-30",
    });
  });

  it("omits the week_ending field from the body when not provided", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGenerateWeeklyReport(
      { workspace_id: "22222222-2222-2222-2222-222222222222" },
      { fetchImpl },
    );
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGenerateWeeklyReport(
        { workspace_id: "22222222-2222-2222-2222-222222222222" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
