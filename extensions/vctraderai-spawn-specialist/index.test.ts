import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runSpawnSpecialist, SPAWN_SPECIALIST_TOOL_NAME } from "./index.js";

describe("vctraderai-spawn-specialist", () => {
  it("registers the spawn_specialist tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-spawn-specialist" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: SPAWN_SPECIALIST_TOOL_NAME,
      label: "Spawn Specialist",
    });
  });

  it("POSTs the spawn path with the X-OpenClaw-Tool header", async () => {
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
    await runSpawnSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/specialists/spawn");
    expect(capturedMethod).toBe("POST");
    expect(capturedToolHeader).toBe(SPAWN_SPECIALIST_TOOL_NAME);
  });

  it("does not send a body-supplied workspace_id (server derives it)", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runSpawnSpecialist(
      { specialist_key: "gold_specialist", instrument: "XAUUSD" },
      { fetchImpl },
    );
    expect(capturedBody).toMatchObject({ specialist_key: "gold_specialist", instrument: "XAUUSD" });
    expect("workspace_id" in capturedBody).toBe(false);
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runSpawnSpecialist(
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
    await runSpawnSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl });
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("unprocessable", {
        status: 422,
        statusText: "Unprocessable Entity",
      })) as typeof globalThis.fetch;
    await expect(
      runSpawnSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_422", status: 422 },
    });
  });
});
