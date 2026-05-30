import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runListSessions, LIST_SESSIONS_TOOL_NAME } from "./index.js";

describe("vctraderai-list-sessions", () => {
  it("registers the list_sessions tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-sessions" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_SESSIONS_TOOL_NAME,
      label: "List Sessions",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      rows: [
        ["sess-1", "LONDON", "07:00:00", "16:00:00"],
        ["sess-2", "NEW_YORK", "12:00:00", "21:00:00"],
      ],
      sources: ["postgres://core.sessions"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runListSessions({ fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path with no query parameters", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListSessions({ fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/sessions");
    expect(parsed.searchParams.toString()).toBe("");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runListSessions({ fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
