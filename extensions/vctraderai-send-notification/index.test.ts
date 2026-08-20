import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runSendNotification, SEND_NOTIFICATION_TOOL_NAME } from "./index.js";

describe("vctraderai-send-notification", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  function captureFetch(): {
    fetchImpl: typeof globalThis.fetch;
    seen: { url: string; method: string; headers: Record<string, string>; body: any };
  } {
    const seen = { url: "", method: "", headers: {} as Record<string, string>, body: undefined };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.method = init?.method ?? "GET";
      seen.headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      seen.body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ notification_id: "ntf-1" }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetchImpl, seen };
  }

  it("registers the send_notification tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: SEND_NOTIFICATION_TOOL_NAME,
      label: "Send Notification",
    });
  });

  // The description is what the MODEL reads, so it is asserted like behaviour.
  // Regression guard for the PROPOSE_ONLY -> DIRECT_CONTROL drift (#1328): the
  // schema told the model this tool staged a proposal for a full day after it
  // stopped doing so, and TOOLS.md had to spend a paragraph contradicting it.
  it("describes itself as writing straight through, never as staging a proposal", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const description = captured.tools[0].description;
    expect(description).toMatch(/STRAIGHT THROUGH/);
    expect(description).not.toMatch(/PROPOSE_ONLY/i);
    expect(description).not.toMatch(/stages? a proposal/i);
    expect(description).not.toMatch(/review \+ Apply/i);
  });

  it("exposes attachments in the schema so a published report can be delivered", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const parameters = captured.tools[0].parameters as any;
    const attachments = parameters?.properties?.attachments;
    expect(attachments).toBeDefined();
    // Optional: an account-independent notification must stay expressible.
    expect(parameters.required ?? []).not.toContain("attachments");
    const item = attachments.type === "array" ? attachments.items : attachments.anyOf?.[0]?.items;
    expect(item?.properties?.kind?.const).toBe("report");
    expect(item?.required).toEqual(expect.arrayContaining(["kind", "id"]));
  });

  it("posts straight through to the direct-control notifications route", async () => {
    const { fetchImpl, seen } = captureFetch();
    await runSendNotification({ title: "title-x" } as any, { fetchImpl });
    expect(new URL(seen.url).pathname).toBe("/api/v1/openclaw/notifications/send");
    expect(seen.method).toBe("POST");
    expect(seen.headers["x-openclaw-tool"]).toBe("send_notification");
    expect(seen.body).toMatchObject({ title: "title-x", workspace_id: "ws-001" });
    // No staging envelope: the params ARE the body, not nested under `params`.
    expect(seen.body.params).toBeUndefined();
    expect(seen.body.tool_name).toBeUndefined();
  });

  it("forwards attachments verbatim to the bff", async () => {
    const { fetchImpl, seen } = captureFetch();
    await runSendNotification(
      { title: "Daily wrap", attachments: [{ kind: "report", id: "rpt-42" }] } as any,
      { fetchImpl },
    );
    expect(seen.body.attachments).toEqual([{ kind: "report", id: "rpt-42" }]);
  });

  it("surfaces a structured error on bff 403 (tool forbidden)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runSendNotification({ title: "title-x" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
