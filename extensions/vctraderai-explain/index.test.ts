import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runExplain, EXPLAIN_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb";
const DECISION_ID = "11112222-3333-4444-5555-666677778888";

function buildFetch(payload: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

describe("vctraderai-explain", () => {
  it("registers the explain tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-explain" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: EXPLAIN_TOOL_NAME,
      label: "Explain",
    });
  });

  it("returns the ledger entry plus a narrative summary on the happy path", async () => {
    const entry = {
      ledger_id: DECISION_ID,
      kind: "risk_check",
      subkind: "exposure_cap",
      occurred_at: "2026-05-29T12:00:00Z",
      payload: { reason: "max_open_positions" },
    };
    const result = await runExplain(WORKSPACE_ID, DECISION_ID, {
      fetchImpl: buildFetch(entry),
    });
    expect(result.entry).toEqual(entry);
    expect(result.summary).toContain("risk_check/exposure_cap");
    expect(result.summary).toContain("2026-05-29T12:00:00Z");
  });

  it("falls back to 'unknown' kind when the entry omits kind", async () => {
    const entry = { ledger_id: DECISION_ID };
    const result = await runExplain(WORKSPACE_ID, DECISION_ID, {
      fetchImpl: buildFetch(entry),
    });
    expect(result.summary).toContain("unknown");
  });

  it("surfaces a structured error on bff 404", async () => {
    const fetchImpl = (async () =>
      new Response("missing", { status: 404, statusText: "Not Found" })) as typeof globalThis.fetch;
    await expect(runExplain(WORKSPACE_ID, DECISION_ID, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_404", status: 404 },
    });
  });
});
