// Tool allowlist tests cover tool availability for isolated cron runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "../../secrets/runtime-web-tools-state.js";
import {
  hasUsableWebSearchProviderMock,
  loadModelCatalogMock,
  loadRunCronIsolatedAgentTurn,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE =
  "web_search tool requested in toolsAllow but no web search provider is selected. Configure one with: openclaw configure --section web, or set tools.web.search.provider.";
const MCP_SUPPRESSION_DIAGNOSTIC_MESSAGE =
  "This automation's explicit toolsAllow omits every configured MCP selector, so no configured MCP tools will be exposed. Add bundle-mcp, group:plugins, a matching <server>__<tool> selector, or * to enable configured MCP tools.";

const RUN_TOOLS_ALLOW_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "tools-allow",
      name: "Tools Allow",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check allowed tools" },
      delivery: { mode: "none" },
      owner: {
        agentId: "main",
        sessionKey: "agent:main:whatsapp:group:team",
        accountId: "default",
      },
    } as never,
    message: "check allowed tools",
    sessionKey: "cron:tools-allow",
  };
}

function makeParamsWithToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "external", channel: "whatsapp" },
      },
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
      },
    } as never,
  };
}

function makeParamsWithDefaultToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
        toolsAllowIsDefault: true,
      },
    } as never,
  };
}

function requireEmbeddedAgentCall(): {
  jobId?: string;
  toolsAllow?: string[];
  scheduledToolPolicy?: {
    version: 1;
    mode: "account";
    ownerSessionKey: string;
    ownerAccountId: string;
    ownerOrigin: { kind: "external"; channel: string } | { kind: "local" } | { kind: "unknown" };
  };
} {
  const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
    | {
        jobId?: string;
        toolsAllow?: string[];
        scheduledToolPolicy?: {
          version: 1;
          mode: "account";
          ownerSessionKey: string;
          ownerAccountId: string;
          ownerOrigin:
            | { kind: "external"; channel: string }
            | { kind: "local" }
            | { kind: "unknown" };
        };
      }
    | undefined;
  if (!call) {
    throw new Error("Expected embedded OpenClaw agent call for toolsAllow passthrough");
  }
  return call;
}

describe("runCronIsolatedAgentTurn toolsAllow passthrough", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    clearActiveRuntimeWebToolsMetadata();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "forum",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      const result = await runInitialModelFallbackAttempt(params);
      return { result, provider: params.provider, model: params.model, attempts: [] };
    });
  });

  afterEach(() => {
    clearActiveRuntimeWebToolsMetadata();
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "keeps capless legacy runs on the ordinary policy path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParams());

      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toBeUndefined();
      expect(call.scheduledToolPolicy).toBeUndefined();
    },
  );

  it(
    "keeps capped accountless legacy jobs on the ordinary sender-policy path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["cron"]);
      delete (params.job as { owner?: { accountId?: string } }).owner?.accountId;

      await runCronIsolatedAgentTurn(params);

      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["cron"]);
      expect(call.scheduledToolPolicy).toBeUndefined();
    },
  );

  it(
    "passes through isolated cron toolsAllow=cron self-removal path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual(["cron"]);
      expect(call.scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
        ownerOrigin: { kind: "external", channel: "whatsapp" },
      });
    },
  );

  it(
    "preserves explicit local scheduled-tool provenance",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithDefaultToolsAllow(["transcripts"]);
      (params.job as { toolsAllowProvenance?: unknown }).toolsAllowProvenance = {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "local" },
      };

      await runCronIsolatedAgentTurn(params);

      expect(requireEmbeddedAgentCall().scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
        ownerOrigin: { kind: "local" },
      });
    },
  );

  it(
    "preserves cron toolsAllow casing for downstream policy resolution",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow([" CRON "]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual([" CRON "]);
    },
  );

  it(
    "passes through non-cron toolsAllow entries",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["maniple__check_idle_workers"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["maniple__check_idle_workers"]);
    },
  );

  it(
    "adds cron diagnostics when web_search is allowed without a selected provider",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["web_search"]);
      expect(result.diagnostics?.summary).toBe(MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE);
      expect(result.diagnostics?.entries).toEqual([
        {
          ts: expect.any(Number),
          source: "cron-preflight",
          severity: "warn",
          message: MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
          toolName: "web_search",
        },
      ]);
    },
  );

  it(
    "persists MCP suppression diagnostics through a successful run",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["read"]);
      params.cfg = {
        mcp: {
          servers: {
            notes: { transport: "stdio", command: "notes-mcp" },
          },
        },
      } as never;

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("ok");
      expect(result.diagnostics?.summary).toBe(MCP_SUPPRESSION_DIAGNOSTIC_MESSAGE);
      expect(result.diagnostics?.entries).toEqual([
        {
          ts: expect.any(Number),
          source: "cron-preflight",
          severity: "warn",
          message: MCP_SUPPRESSION_DIAGNOSTIC_MESSAGE,
        },
      ]);
    },
  );

  it(
    "persists MCP suppression diagnostics when execution throws",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      runWithModelFallbackMock.mockRejectedValueOnce(new Error("LLM provider timeout"));
      const params = makeParamsWithToolsAllow(["read"]);
      params.cfg = {
        mcp: {
          servers: {
            notes: { transport: "stdio", command: "notes-mcp" },
          },
        },
      } as never;

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("error");
      expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
        MCP_SUPPRESSION_DIAGNOSTIC_MESSAGE,
        "LLM provider timeout",
      ]);
    },
  );

  it(
    "uses the final failed runtime for MCP suppression diagnostics",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      resolveEffectiveAgentRuntimeMock.mockImplementation(({ provider }: { provider: string }) =>
        provider === "anthropic" ? "codex" : "openclaw",
      );
      runWithModelFallbackMock.mockRejectedValueOnce(
        new FailoverError("fallback exhausted", {
          reason: "unknown",
          provider: "anthropic",
          model: "claude-sonnet-5",
        }),
      );
      const params = makeParamsWithToolsAllow(["read"]);
      params.cfg = {
        mcp: {
          servers: {
            notes: {
              transport: "stdio",
              command: "notes-mcp",
              codex: { agents: ["research"] },
            },
          },
        },
      } as never;

      const result = await runCronIsolatedAgentTurn(params);

      expect(result).toMatchObject({
        status: "error",
        provider: "anthropic",
        model: "claude-sonnet-5",
      });
      expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
        "fallback exhausted",
      ]);
    },
  );

  it(
    "uses the final attempted runtime when terminal fallback throws an unclassified error",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      resolveEffectiveAgentRuntimeMock.mockImplementation(({ provider }: { provider: string }) =>
        provider === "anthropic" ? "codex" : "openclaw",
      );
      runEmbeddedAgentMock
        .mockRejectedValueOnce(new Error("primary failed"))
        .mockRejectedValueOnce(new Error("terminal fallback failed"));
      runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
        await run(provider, model).catch(() => undefined);
        return await run("anthropic", "claude-sonnet-5");
      });
      const params = makeParamsWithToolsAllow(["read"]);
      params.cfg = {
        mcp: {
          servers: {
            notes: {
              transport: "stdio",
              command: "notes-mcp",
              codex: { agents: ["research"] },
            },
          },
        },
      } as never;

      const result = await runCronIsolatedAgentTurn(params);

      expect(result).toMatchObject({
        status: "error",
        provider: "anthropic",
        model: "claude-sonnet-5",
      });
      expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
        "terminal fallback failed",
      ]);
    },
  );

  it(
    "retains both MCP and web search preflight diagnostics",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["read", "web_search"]);
      params.cfg = {
        mcp: {
          servers: {
            notes: { transport: "stdio", command: "notes-mcp" },
          },
        },
      } as never;

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("ok");
      expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
        MCP_SUPPRESSION_DIAGNOSTIC_MESSAGE,
        MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
      ]);
    },
  );

  it.each([
    {
      name: "adds the warning after a Codex-to-OpenClaw fallback",
      runtimeForProvider: (provider: string) => (provider === "openai" ? "codex" : "openclaw"),
      expectedSummary: MCP_SUPPRESSION_DIAGNOSTIC_MESSAGE,
    },
    {
      name: "removes the warning after an OpenClaw-to-Codex fallback",
      runtimeForProvider: (provider: string) => (provider === "openai" ? "openclaw" : "codex"),
      expectedSummary: undefined,
    },
  ])("$name", async ({ runtimeForProvider, expectedSummary }) => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ provider }: { provider: string }) =>
      runtimeForProvider(provider),
    );
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      const result = await run("anthropic", "claude-sonnet-5");
      return { result, provider: "anthropic", model: "claude-sonnet-5", attempts: [] };
    });
    const params = makeParamsWithToolsAllow(["read"]);
    params.cfg = {
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "notes-mcp",
            codex: { agents: ["research"] },
          },
        },
      },
    } as never;

    const result = await runCronIsolatedAgentTurn(params);

    expect(result.status).toBe("ok");
    expect(result.diagnostics?.summary).toBe(expectedSummary);
  });

  it(
    "uses the prepared provider selected from a plugin-scoped web search key",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      setActiveRuntimeWebToolsMetadata({
        search: {
          providerSource: "auto-detect",
          selectedProvider: "brave",
          selectedProviderKeySource: "config",
          diagnostics: [],
        },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      });
      const cfg = {
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: { apiKey: "token-oversized" },
              },
            },
          },
        },
      };

      const result = await runCronIsolatedAgentTurn({
        ...makeParamsWithToolsAllow(["web_search"]),
        cfg,
      });

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
      expect(hasUsableWebSearchProviderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: "/tmp/agent-dir",
          preferRuntimeProviders: true,
          runtimeWebSearch: expect.objectContaining({ selectedProvider: "brave" }),
        }),
      );
    },
  );

  it(
    "does not warn for default-derived toolsAllow that includes web_search",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const result = await runCronIsolatedAgentTurn(
        makeParamsWithDefaultToolsAllow(["web_search"]),
      );

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
    },
  );

  it(
    "does not warn when native web_search suppresses the managed provider tool",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      resolveConfiguredModelRefMock.mockReturnValue({
        provider: "gateway",
        model: "gpt-5.5",
      });
      loadModelCatalogMock.mockResolvedValue([
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "gateway",
          api: "openai-chatgpt-responses",
        },
      ]);

      const result = await runCronIsolatedAgentTurn({
        ...makeParamsWithToolsAllow(["web_search"]),
        cfg: {
          tools: {
            web: {
              search: {
                enabled: true,
                openaiCodex: {
                  enabled: true,
                  mode: "cached",
                },
              },
            },
          },
        },
      });

      expect(result.status).toBe("ok");
      expect(result.diagnostics).toBeUndefined();
    },
  );

  it(
    "keeps web_search provider diagnostics when the run aborts",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      runWithModelFallbackMock.mockResolvedValueOnce({
        result: {
          payloads: [],
          meta: {
            aborted: true,
            agentMeta: {},
          },
        },
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      });

      const result = await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["web_search"]));

      expect(result.status).toBe("error");
      expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
        MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
        "cron isolated agent run aborted",
      ]);
    },
  );
});
