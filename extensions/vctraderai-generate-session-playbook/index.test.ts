import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, {
  runGenerateSessionPlaybook,
  GENERATE_SESSION_PLAYBOOK_TOOL_NAME,
} from "./index.js";

describe("vctraderai-generate-session-playbook", () => {
  it("registers the generate_session_playbook tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-session-playbook",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GENERATE_SESSION_PLAYBOOK_TOOL_NAME,
      label: "Generate Session Playbook",
    });
  });

  it("returns the playbook envelope verbatim on the happy path", async () => {
    const envelope = {
      workspace_id: "33333333-3333-3333-3333-333333333333",
      session: "LONDON",
      playbook: { focus_pairs: ["EURUSD", "GBPUSD"], bias: "neutral" },
      sources: ["postgres://core.sessions"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGenerateSessionPlaybook(
      { workspace_id: "33333333-3333-3333-3333-333333333333", session: "LONDON" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the BFF playbooks/session endpoint with POST and a JSON body", async () => {
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
    await runGenerateSessionPlaybook(
      { workspace_id: "33333333-3333-3333-3333-333333333333", session: "NEW_YORK" },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/playbooks/session");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "33333333-3333-3333-3333-333333333333",
      session: "NEW_YORK",
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGenerateSessionPlaybook(
        { workspace_id: "33333333-3333-3333-3333-333333333333", session: "LONDON" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
