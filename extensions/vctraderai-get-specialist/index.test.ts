import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetSpecialist, GET_SPECIALIST_TOOL_NAME } from "./index.js";

describe("vctraderai-get-specialist", () => {
  it("registers the get_specialist tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-specialist" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_SPECIALIST_TOOL_NAME,
      label: "Get Specialist",
    });
  });

  it("GETs the specialists path including the URL-encoded specialist_key path param", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedToolHeader: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "";
      capturedToolHeader = new Headers(init?.headers).get("x-openclaw-tool");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/specialists/gold_specialist");
    expect(capturedMethod).toBe("GET");
    expect(capturedToolHeader).toBe(GET_SPECIALIST_TOOL_NAME);
  });

  it("throws when specialist_key is missing", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runGetSpecialist({}, { fetchImpl })).rejects.toThrow(/specialist_key is required/);
  });

  it("returns the specialist envelope verbatim on the happy path", async () => {
    const envelope = {
      ok: true,
      specialist: { specialist_key: "gold_specialist", display_name: "Gold" },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSpecialist(
      { specialist_key: "gold_specialist" },
      { fetchImpl, threadId: "thread-specialist-7" },
    );
    expect(capturedThreadHeader).toBe("thread-specialist-7");
  });

  it("omits X-OpenClaw-Thread when no thread id is supplied", async () => {
    let hasThreadHeader = true;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      hasThreadHeader = new Headers(init?.headers).has("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl });
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 404", async () => {
    const fetchImpl = (async () =>
      new Response("not found", {
        status: 404,
        statusText: "Not Found",
      })) as typeof globalThis.fetch;
    await expect(
      runGetSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_404", status: 404 },
    });
  });
});
