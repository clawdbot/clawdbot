import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin, { runAccountState, ACCOUNT_STATE_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

function buildFetch(handlers: Record<string, unknown>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = Object.entries(handlers).find(([path]) => url.endsWith(path));
    if (!match) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    return new Response(JSON.stringify(match[1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("vctraderai-account-state", () => {
  it("registers the account_state tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-account-state" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: ACCOUNT_STATE_TOOL_NAME,
      label: "Account State",
    });
  });

  it("composes dashboard + accounts payloads on the happy path", async () => {
    const stats = { card_count: 5 };
    const accounts = { rows: [{ id: "a1" }, { id: "a2" }] };
    const fetchImpl = buildFetch({
      [`/api/v1/workspaces/${WORKSPACE_ID}/dashboard/home`]: stats,
      [`/api/v1/workspaces/${WORKSPACE_ID}/accounts?state=active`]: accounts,
    });
    const result = await runAccountState(WORKSPACE_ID, { fetchImpl });
    expect(result).toEqual({ stats, accounts });
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(runAccountState(WORKSPACE_ID, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });

  it("aborts when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      runAccountState(
        WORKSPACE_ID,
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
