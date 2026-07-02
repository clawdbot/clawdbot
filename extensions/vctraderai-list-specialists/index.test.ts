import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runListSpecialists, LIST_SPECIALISTS_TOOL_NAME } from "./index.js";

describe("vctraderai-list-specialists", () => {
  it("registers the list_specialists tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-specialists" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_SPECIALISTS_TOOL_NAME,
      label: "List Specialists",
    });
  });

  it("GETs the specialists collection path with no body or query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown;
    let capturedToolHeader: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body;
      capturedToolHeader = new Headers(init?.headers).get("x-openclaw-tool");
      return new Response(JSON.stringify({ ok: true, specialists: [] }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListSpecialists({}, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/specialists");
    expect(parsed.search).toBe("");
    expect(capturedMethod).toBe("GET");
    expect(capturedBody).toBeUndefined();
    expect(capturedToolHeader).toBe(LIST_SPECIALISTS_TOOL_NAME);
  });

  it("returns the list envelope verbatim on the happy path", async () => {
    const envelope = {
      ok: true,
      specialists: [{ specialist_key: "gold_specialist", display_name: "Gold" }],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runListSpecialists({}, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true, specialists: [] }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListSpecialists({}, { fetchImpl, threadId: "thread-specialist-7" });
    expect(capturedThreadHeader).toBe("thread-specialist-7");
  });

  it("omits X-OpenClaw-Thread when no thread id is supplied", async () => {
    let hasThreadHeader = true;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      hasThreadHeader = new Headers(init?.headers).has("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true, specialists: [] }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListSpecialists({}, { fetchImpl });
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runListSpecialists({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
