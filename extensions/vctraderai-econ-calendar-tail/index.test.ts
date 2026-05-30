import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runEconCalendarTail, ECON_CALENDAR_TAIL_TOOL_NAME } from "./index.js";

describe("vctraderai-econ-calendar-tail", () => {
  it("registers the econ_calendar_tail tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-econ-calendar-tail" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: ECON_CALENDAR_TAIL_TOOL_NAME,
      label: "Econ Calendar Tail",
    });
  });

  it("returns the econ-calendar envelope verbatim on the happy path", async () => {
    const envelope = {
      rows: [
        { event: "FOMC Rate Decision", timestamp: "2026-05-28T18:00:00Z", impact: "high" },
        { event: "Non-Farm Payrolls", timestamp: "2026-06-06T12:30:00Z", impact: "high" },
      ],
      schema: [
        { name: "event", type: "string" },
        { name: "timestamp", type: "timestamp[us]" },
        { name: "impact", type: "string" },
      ],
      source: "questdb:econ_calendar",
      filters: { n: 2 },
      sources: ["questdb:econ_calendar"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runEconCalendarTail({ n: 2 }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the econ-calendar/tail path and forwards n as query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runEconCalendarTail({ n: 10 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/data/econ-calendar/tail");
    expect(parsed.searchParams.get("n")).toBe("10");
  });

  it("omits n from the query string when undefined", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runEconCalendarTail({}, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.has("n")).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runEconCalendarTail({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
