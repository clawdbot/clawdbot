// Tool allowlist tests cover tool availability for isolated cron runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE =
  "web_search tool requested in toolsAllow but no web search provider is selected. Configure one with: openclaw configure --section web, or set tools.web.search.provider.";

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
    "fails a structured command prompt without shell access before model execution",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["terminal", "node_exec", "node_process"]);
      (params.job as { payload: { message: string } }).payload.message = [
        "Command to run:",
        "- command: python3 scripts/check_mail.py",
        "- workdir: /srv/openclaw",
      ].join("\n");

      const result = await runCronIsolatedAgentTurn(params);

      expect(result).toMatchObject({
        status: "error",
        admissionDisposition: "rejected",
        error: expect.stringContaining(
          "openclaw automations edit tools-allow --tools exec,process",
        ),
        diagnostics: {
          summary: expect.stringContaining("No command was executed"),
          entries: [expect.objectContaining({ source: "cron-preflight", severity: "error" })],
        },
      });
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(resolveConfiguredModelRefMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a blank tool allowlist entry", [" "]],
    ["a noncanonical shell pseudo-tool", ["shell"]],
    ["the patch-only tool", ["apply_patch"]],
  ])(
    "does not treat %s as shell access",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async (_label, toolsAllow) => {
      const params = makeParamsWithToolsAllow(toolsAllow);
      (params.job as { payload: { message: string } }).payload.message = [
        "Command to run:",
        "- command: python3 scripts/check_mail.py",
      ].join("\n");

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("error");
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    },
  );

  it(
    "keeps a structured command prompt with explicit shell access runnable",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["exec", "read"]);
      (params.job as { payload: { message: string } }).payload.message = [
        "Command to run:",
        "- command: python3 scripts/check_mail.py",
        "- workdir: /srv/openclaw",
      ].join("\n");

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(requireEmbeddedAgentCall().toolsAllow).toEqual(["exec", "read"]);
    },
  );

  it(
    "keeps a structured command prompt with process access runnable",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["process"]);
      (params.job as { payload: { message: string } }).payload.message = [
        "Command to run:",
        "- command: python3 scripts/check_mail.py",
      ].join("\n");

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(requireEmbeddedAgentCall().toolsAllow).toEqual(["process"]);
    },
  );

  it(
    "keeps a structured command prompt with grouped shell access runnable",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["group:runtime"]);
      (params.job as { payload: { message: string } }).payload.message = [
        "Command to run:",
        "- command: python3 scripts/check_mail.py",
        "- workdir: /srv/openclaw",
      ].join("\n");

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(requireEmbeddedAgentCall().toolsAllow).toEqual(["group:runtime"]);
    },
  );

  it(
    "keeps a structured command prompt with wildcard shell access runnable",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["exec*"]);
      (params.job as { payload: { message: string } }).payload.message = [
        "Command to run:",
        "- command: python3 scripts/check_mail.py",
      ].join("\n");

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(requireEmbeddedAgentCall().toolsAllow).toEqual(["exec*"]);
    },
  );

  it(
    "does not reject an explanatory prompt that only mentions a command",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["read", "message"]);
      (params.job as { payload: { message: string } }).payload.message =
        "Explain whether the operator should run python3 scripts/check_mail.py.";

      const result = await runCronIsolatedAgentTurn(params);

      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
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
