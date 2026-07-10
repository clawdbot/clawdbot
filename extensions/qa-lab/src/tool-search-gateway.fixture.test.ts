// Qa Lab tests cover Tool Search gateway flow fixture behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countSessionLogMentions,
  countSystemPromptChars,
  outputText,
  outputToolNames,
} from "./fixture-utils.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import {
  assertToolSearchLaneResults,
  fetchJson,
  readToolSearchGatewayFetchLimits,
  runToolSearchGatewayLane,
} from "./tool-search-gateway.fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
        OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS: "5000",
      }),
    ).toEqual({
      bodyMaxBytes: 4096,
      timeoutMs: 5_000,
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

describe("tool search gateway e2e session log scanner", () => {
  it("does not count target mentions from user prompt records", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-search-log-"));
    try {
      const sessionsDir = path.join(stateDir, "agents", "qa", "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, "session.jsonl"),
        [
          JSON.stringify({
            message: {
              role: "user",
              content: "tool search qa check target=fake_plugin_tool_17",
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: "FAKE_PLUGIN_OK fake_plugin_tool_17",
            },
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      await expect(
        countSessionLogMentions({
          sessionsDir,
          needles: {
            fake_plugin_tool_17: "fake_plugin_tool_17",
            tool_search_code: "tool_search_code",
          },
        }),
      ).resolves.toEqual({
        fake_plugin_tool_17: 1,
        tool_search_code: 0,
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("tool search gateway e2e lane result", () => {
  it("preserves surrogate pairs in provider request snippets", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-search-lane-"));
    const configPath = path.join(tempRoot, "openclaw.json");
    const inputPrefix = "i".repeat(499);
    const toolOutputPrefix = "o".repeat(3_999);
    await fs.writeFile(configPath, "{}\n", "utf8");
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ output: [], status: "completed" }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            allInputText: `${inputPrefix}😀tail`,
            body: { tools: [] },
            plannedToolName: "fake_plugin_tool_17",
            raw: "{}",
            toolOutput: `${toolOutputPrefix}😀tail`,
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const env: QaSuiteRuntimeEnv = {
      alternateModel: "openai/gpt-5.5",
      cfg: {},
      gateway: {
        baseUrl: "http://gateway.test",
        call: async () => undefined,
        restartAfterStateMutation: async (mutateState) => {
          await mutateState({
            configPath,
            runtimeEnv: {},
            stateDir: path.join(tempRoot, "state"),
            tempRoot,
          });
        },
        runtimeEnv: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
        tempRoot,
        workspaceDir: tempRoot,
      },
      mock: { baseUrl: "http://mock-openai.test" },
      primaryModel: "openai/gpt-5.5",
      providerMode: "mock-openai",
      repoRoot: tempRoot,
      transport: {} as QaSuiteRuntimeEnv["transport"],
    };

    try {
      const result = await runToolSearchGatewayLane({
        env,
        fixture: { fakePluginDir: tempRoot, targetTool: "fake_plugin_tool_17" },
        lane: "normal",
      });

      expect(result.providerInputSnippet).toBe(inputPrefix);
      expect(result.providerToolOutputSnippet).toBe(toolOutputPrefix);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("qa fixture response helpers", () => {
  it("reads Responses API text, function call names, and prompt sizing", () => {
    const payload = {
      output: [
        { type: "function_call", name: "fake_plugin_tool_17" },
        {
          type: "message",
          content: [{ text: "alpha" }, { text: "beta" }],
        },
      ],
    };

    expect(outputToolNames(payload)).toEqual(["fake_plugin_tool_17"]);
    expect(outputText(payload)).toBe("alpha\nbeta");
    expect(
      countSystemPromptChars({
        instructions: "abc",
        input: [
          { role: "system", content: [{ type: "input_text", text: "def" }] },
          { role: "developer", content: "ghi" },
          { role: "user", content: [{ type: "input_text", text: "ignored" }] },
        ],
      }),
    ).toBe(9);
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

  it("preserves surrogate pairs in both lane debug output snippets", () => {
    const outputPrefix = `FAKE_PLUGIN_OK ${targetTool} `;
    const normalOutput = `${outputPrefix}${"n".repeat(299 - outputPrefix.length)}`;
    const codeOutput = `${outputPrefix}${"c".repeat(299 - outputPrefix.length)}`;
    const assertInvalidLaneResults = () =>
      assertToolSearchLaneResults({
        targetTool,
        normal: {
          ...normal,
          gatewayOutputText: `${normalOutput}😀tail`,
        },
        code: {
          gatewayOutputText: `${codeOutput}😀tail`,
          providerDeclaredToolCount: 1,
          providerPlannedTools: ["tool_search_code", targetTool],
          providerRawBytes: 4_000,
          sessionLogToolMentions: {
            tool_search_code: 1,
            [targetTool]: 1,
          },
        },
      });

    expect(assertInvalidLaneResults).toThrow(`"output": "${normalOutput}"`);
    expect(assertInvalidLaneResults).toThrow(`"output": "${codeOutput}"`);
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

  it("rejects code lane proof that also exposes the direct target tool", () => {
    expect(() =>
      assertToolSearchLaneResults({
        normal,
        targetTool,
        code: {
          gatewayOutputText: `FAKE_PLUGIN_OK ${targetTool}`,
          providerDeclaredToolCount: 2,
          providerPlannedTools: ["tool_search_code", targetTool],
          providerRawBytes: 4_000,
          sessionLogToolMentions: {
            tool_search_code: 1,
            [targetTool]: 1,
          },
        },
      }),
    ).toThrow(`code lane exposed direct provider tool ${targetTool}`);
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

  it("rejects normal lane proof that uses the Tool Search bridge", () => {
    expect(() =>
      assertToolSearchLaneResults({
        targetTool,
        normal: {
          ...normal,
          providerPlannedTools: [targetTool, "tool_search_code"],
          sessionLogToolMentions: {
            tool_search_code: 1,
            [targetTool]: 1,
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
    ).toThrow("normal lane unexpectedly used Tool Search bridge");
  });
});
