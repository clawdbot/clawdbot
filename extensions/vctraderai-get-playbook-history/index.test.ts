import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetPlaybookHistory, GET_PLAYBOOK_HISTORY_TOOL_NAME } from "./index.js";

describe("vctraderai-get-playbook-history", () => {
  it("registers the get_playbook_history tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-get-playbook-history",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_PLAYBOOK_HISTORY_TOOL_NAME,
      label: "Get Playbook History",
    });
  });

  it("returns the history envelope verbatim on the happy path", async () => {
    const envelope = {
      workspace_id: "44444444-4444-4444-4444-444444444444",
      playbooks: [{ session: "LONDON", generated_at: "2026-05-30T08:00:00Z" }],
      sources: ["postgres://core.playbook_history"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetPlaybookHistory(
      { workspace_id: "44444444-4444-4444-4444-444444444444" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the BFF playbooks/history endpoint with GET and the query params", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetPlaybookHistory(
      { workspace_id: "44444444-4444-4444-4444-444444444444", limit: 50 },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/playbooks/history");
    expect(parsed.searchParams.get("workspace_id")).toBe("44444444-4444-4444-4444-444444444444");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(capturedMethod).toBe("GET");
  });

  it("omits the limit query param when not provided", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetPlaybookHistory(
      { workspace_id: "44444444-4444-4444-4444-444444444444" },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("limit")).toBeNull();
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGetPlaybookHistory(
        { workspace_id: "44444444-4444-4444-4444-444444444444" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
