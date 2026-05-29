import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runAudit, AUDIT_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11112222-3333-4444-5555-666677778888";
const THREAD_ID = "99998888-7777-6666-5555-444433332222";

describe("vctraderai-audit", () => {
  it("registers the audit tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-audit" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: AUDIT_TOOL_NAME,
      label: "Audit",
    });
  });

  it("returns the audit envelope verbatim on the happy path", async () => {
    const envelope = {
      thread_id: THREAD_ID,
      timeline: [
        { ts: "2026-05-29T12:00:00Z", kind: "tool_call", name: "account_state" },
        { ts: "2026-05-29T12:00:01Z", kind: "tool_result", name: "account_state" },
      ],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runAudit(WORKSPACE_ID, THREAD_ID, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runAudit(WORKSPACE_ID, THREAD_ID, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
