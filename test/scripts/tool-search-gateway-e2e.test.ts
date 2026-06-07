// Tool Search Gateway E2E tests cover tool search gateway e2e script behavior.
import { describe, expect, it } from "vitest";
import {
  assertToolSearchLaneResults,
  fetchJson,
  readToolSearchGatewayFetchLimits,
  restoreToolSearchGatewayEnv,
  snapshotToolSearchGatewayEnv,
} from "../../scripts/tool-search-gateway-e2e.ts";

describe("tool search gateway e2e fetch helper", () => {
  it("rejects loose numeric env limits instead of parsing prefixes", () => {
    expect(() =>
      readToolSearchGatewayFetchLimits({
        OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS: 1e3");
    expect(() =>
      readToolSearchGatewayFetchLimits({
        OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_BODY_MAX_BYTES: "1000ms",
      }),
    ).toThrow("invalid OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_BODY_MAX_BYTES: 1000ms");
    expect(
      readToolSearchGatewayFetchLimits({
        OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_BODY_MAX_BYTES: "4096",
        OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS: "120000",
      }),
    ).toEqual({
      bodyMaxBytes: 4096,
      timeoutMs: 120_000,
    });
  });

  it("aborts requests that never resolve", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      fetchJson("https://qa.example.invalid/debug/requests", undefined, {
        timeoutMs: 25,
        fetchImpl: async (_url, init) => {
          signal = init.signal as AbortSignal | undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/debug/requests timed out after 25ms",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("times out while reading stalled response bodies", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
  });

  it("parses successful JSON responses", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/debug/requests", undefined, {
        timeoutMs: 25,
        fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds oversized response bodies", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/debug/requests", undefined, {
        maxBodyBytes: 16,
        timeoutMs: 1000,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, padding: "x".repeat(128) }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "HTTP response from https://qa.example.invalid/debug/requests exceeded 16 bytes",
    });
  });
});

describe("tool search gateway e2e environment helpers", () => {
  it("restores mutated gateway environment values", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_CONFIG_PATH: "/before/openclaw.json",
      OPENCLAW_STATE_DIR: "/before/state",
    };
    const snapshot = snapshotToolSearchGatewayEnv(env);

    env.OPENCLAW_CONFIG_PATH = "/after/openclaw.json";
    env.OPENCLAW_STATE_DIR = "/after/state";
    env.OPENCLAW_TEST_FAST = "1";

    restoreToolSearchGatewayEnv(snapshot, env);

    expect(env).toEqual({
      OPENCLAW_CONFIG_PATH: "/before/openclaw.json",
      OPENCLAW_STATE_DIR: "/before/state",
    });
  });
});

describe("tool search gateway e2e lane assertions", () => {
  const targetTool = "fake_plugin_tool_17";
  const normal = {
    gatewayOutputText: `FAKE_PLUGIN_OK ${targetTool}`,
    providerDeclaredToolCount: 36,
    providerPlannedTools: [targetTool],
    providerRawBytes: 12_000,
    sessionLogToolMentions: {
      [targetTool]: 1,
    },
  };

  it("accepts code lane proof only when the target plugin tool output is present", () => {
    expect(() =>
      assertToolSearchLaneResults({
        normal,
        targetTool,
        code: {
          gatewayOutputText: `FAKE_PLUGIN_OK ${targetTool}`,
          providerDeclaredToolCount: 1,
          providerPlannedTools: ["tool_search_code"],
          providerRawBytes: 4_000,
          sessionLogToolMentions: {
            tool_search_code: 1,
            [targetTool]: 1,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects code lane output that only echoes the target tool name", () => {
    expect(() =>
      assertToolSearchLaneResults({
        normal,
        targetTool,
        code: {
          gatewayOutputText: targetTool,
          providerDeclaredToolCount: 1,
          providerPlannedTools: ["tool_search_code"],
          providerRawBytes: 4_000,
          sessionLogToolMentions: {
            tool_search_code: 1,
            [targetTool]: 1,
          },
        },
      }),
    ).toThrow(`code lane did not bridge-call ${targetTool}`);
  });

  it("rejects normal lane output that only echoes the target tool name", () => {
    expect(() =>
      assertToolSearchLaneResults({
        targetTool,
        normal: {
          ...normal,
          sessionLogToolMentions: {
            [targetTool]: 0,
          },
        },
        code: {
          gatewayOutputText: `FAKE_PLUGIN_OK ${targetTool}`,
          providerDeclaredToolCount: 1,
          providerPlannedTools: ["tool_search_code"],
          providerRawBytes: 4_000,
          sessionLogToolMentions: {
            tool_search_code: 1,
            [targetTool]: 1,
          },
        },
      }),
    ).toThrow(`normal lane did not call ${targetTool}`);
  });
});
