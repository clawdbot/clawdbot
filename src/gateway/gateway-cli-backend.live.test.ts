// CLI backend live gateway tests exercise registered backend sessions, model switching, MCP loopback, and image probes.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveCliBackendConfig,
  resolveCliBackendLiveTest,
  type ResolvedCliBackend,
} from "../agents/cli-backends.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { getCliLiveSessionGeneration } from "../agents/cli-runner/cli-live-session-registry.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { shouldSkipLiveProviderDrift } from "../agents/live-test-provider-drift.js";
import { parseModelRef } from "../agents/model-selection.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  CLI_CACHE_AUTH_PROFILE_ID,
  createMcpSchemaProbePlugin,
  initializeCacheProbeGitWorkspace,
  logCliCacheUsage,
  MCP_SCHEMA_PROBE_PLUGIN_ID,
  MCP_SCHEMA_PROBE_TOOL_NAME,
  prepareClaudeCacheProbeBackend,
  type RuntimeBackendEntry,
} from "./gateway-cli-backend.live-cache.test-helpers.js";
import {
  applyCliBackendLiveEnv,
  buildClaudeCliResumeContinuityProbe,
  createBootstrapWorkspace,
  ensurePairedTestGatewayClientIdentity,
  getCliBackendPortBlock,
  matchesCliBackendReply,
  parseImageMode,
  parseJsonStringArray,
  isCliBackendLiveTimeoutPayload,
  resolveCliBackendLiveArgs,
  resolveCliBackendLiveModelSelection,
  resolveCliBackendLiveProviderSkipDecision,
  resolveImportedClaudeCliSessionId,
  resolveCliModelSwitchProbeTarget,
  restoreCliBackendLiveEnv,
  shouldAllowCliBackendLiveProviderSkip,
  shouldRetryCliBackendLiveTimeout,
  shouldRunCliImageProbe,
  shouldRunCliModelSwitchProbe,
  shouldRunCliMcpProbe,
  snapshotCliBackendLiveEnv,
  type SystemPromptReport,
  withClaudeMcpConfigOverrides,
  connectTestGatewayClient,
} from "./gateway-cli-backend.live-helpers.js";
import {
  verifyCliBackendImageProbe,
  verifyCliCronMcpLoopbackPreflight,
  verifyCliCronMcpProbe,
} from "./gateway-cli-backend.live-probe-helpers.js";
import { startGatewayServer } from "./server.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const LIVE = isLiveTestEnabled();
const CLI_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND);
const CLI_CACHE_PROBE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_CACHE_PROBE);
const CLI_RESUME =
  CLI_CACHE_PROBE || isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE);
const CLI_DEBUG = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG);
const CLI_CI_SAFE_CODEX_CONFIG = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_CLI_BACKEND_USE_CI_SAFE_CODEX_CONFIG,
);
const CLI_MCP_SCHEMA_PROBE = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_CLI_BACKEND_MCP_SCHEMA_PROBE,
);
const CLI_ALLOW_PROVIDER_SKIP = shouldAllowCliBackendLiveProviderSkip();
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const CLI_CONTINUITY_PROBE_PLUGIN_ID = "cli-continuity-probe";

function createRuntimeBackendEntry(
  backend: ResolvedCliBackend,
  overrides: Pick<RuntimeBackendEntry, "pluginId" | "config" | "bundleMcp">,
): RuntimeBackendEntry {
  const { ownsNativeCompaction, manualCompaction, ...rest } = backend;
  const base = { ...rest, ...overrides };
  return ownsNativeCompaction === true
    ? { ...base, ownsNativeCompaction: true, manualCompaction }
    : { ...base, ownsNativeCompaction: false };
}

const DEFAULT_PROVIDER = "claude-cli";
const DEFAULT_MODEL =
  resolveCliBackendLiveTest(DEFAULT_PROVIDER)?.defaultModelRef ?? "claude-cli/claude-sonnet-4-6";
const CLI_BACKEND_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv(
  "OPENCLAW_LIVE_CLI_BACKEND_REQUEST_TIMEOUT_MS",
  15 * 60_000,
);
const CLI_BACKEND_CODEX_TIMEOUT_RETRY_ATTEMPTS = 2;
const CLI_BACKEND_CODEX_TIMEOUT_RETRY_SLEEP_MS = 5_000;
const CLI_BACKEND_RETRY_WRAPPED_AGENT_REQUESTS = 2;
const CLI_BACKEND_MIN_CACHE_HIT_RATE = 0.9;
const CLI_CACHE_PROBE_INITIAL_THINKING_LEVEL = "medium";
const CLI_CACHE_PROBE_SWITCHED_THINKING_LEVEL = "high";
const CLI_BACKEND_CODEX_TIMEOUT_RETRY_SEQUENCE_MS =
  CLI_BACKEND_REQUEST_TIMEOUT_MS * CLI_BACKEND_CODEX_TIMEOUT_RETRY_ATTEMPTS +
  CLI_BACKEND_CODEX_TIMEOUT_RETRY_SLEEP_MS * (CLI_BACKEND_CODEX_TIMEOUT_RETRY_ATTEMPTS - 1);
// The cron/MCP live probe and Codex timeout retry need enough outer-test headroom
// to finish both the initial agent request and one follow-up probe.
const CLI_BACKEND_LIVE_TIMEOUT_MS = Math.max(
  20 * 60_000,
  CLI_BACKEND_CODEX_TIMEOUT_RETRY_SEQUENCE_MS * CLI_BACKEND_RETRY_WRAPPED_AGENT_REQUESTS +
    2 * 60_000,
);

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return value;
}

function logCliBackendLiveStep(step: string, details?: Record<string, unknown>): void {
  if (!CLI_DEBUG) {
    return;
  }
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.error(`[gateway-cli-live] ${step}${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type CliBackendAgentAttemptTimeouts = {
  agentTimeoutSeconds: number;
  requestTimeoutMs: number;
};

function resolveCliBackendAgentAttemptTimeouts(): CliBackendAgentAttemptTimeouts {
  const requestTimeoutMs = CLI_BACKEND_REQUEST_TIMEOUT_MS;
  return {
    requestTimeoutMs,
    agentTimeoutSeconds: Math.max(1, Math.ceil(requestTimeoutMs / 1000) - 10),
  };
}

function openAiProviderConfigForCodexCli(
  modelKey: string,
): NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>["openai"] {
  const parsed = parseModelRef(modelKey, DEFAULT_PROVIDER);
  const modelId = parsed?.model?.trim() || "gpt-5.6-luna";
  return {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        contextWindow: 1_047_576,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: modelId,
        input: ["text"],
        maxTokens: 32_768,
        name: modelId,
        reasoning: true,
      },
    ],
    timeoutSeconds: Math.ceil(CLI_BACKEND_REQUEST_TIMEOUT_MS / 1000),
  };
}

function isProviderCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("529") &&
    (normalized.includes("overloaded") || normalized.includes("capacity"))
  );
}

async function requestWithProviderCapacityRetry<T>(
  providerId: string,
  label: string,
  request: () => Promise<T>,
): Promise<T | undefined> {
  const maxAttempts = providerId === "claude-cli" ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isProviderCapacityError(error) || attempt >= maxAttempts) {
        const driftSkip = shouldSkipLiveProviderDrift({
          error,
          allowAuth: true,
          allowBilling: true,
        });
        if (driftSkip) {
          const decision = resolveCliBackendLiveProviderSkipDecision({
            allowProviderSkip: CLI_ALLOW_PROVIDER_SKIP,
            label,
            providerId,
            reasonLabel: driftSkip.label,
          });
          if (decision.action === "skip") {
            console.warn(`SKIP: ${decision.message}`);
            return undefined;
          }
          throw new Error(decision.message, { cause: error });
        }
        if (providerId === "claude-cli" && isProviderCapacityError(error)) {
          const decision = resolveCliBackendLiveProviderSkipDecision({
            allowProviderSkip: CLI_ALLOW_PROVIDER_SKIP,
            label,
            providerId,
            reasonLabel: "Claude API capacity",
          });
          if (decision.action === "skip") {
            console.warn(`SKIP: ${decision.message}`);
            return undefined;
          }
          throw new Error(decision.message, { cause: error });
        }
        throw error;
      }
      logCliBackendLiveStep("provider-capacity-retry", { label, attempt });
      await sleep(15_000 * attempt);
    }
  }
  return undefined;
}

async function requestWithCodexTimeoutRetry<T>(
  providerId: string,
  label: string,
  request: (timeouts: CliBackendAgentAttemptTimeouts) => Promise<T>,
): Promise<T | undefined> {
  const maxAttempts = providerId === "codex-cli" ? CLI_BACKEND_CODEX_TIMEOUT_RETRY_ATTEMPTS : 1;
  const retrySleepMs = providerId === "codex-cli" ? CLI_BACKEND_CODEX_TIMEOUT_RETRY_SLEEP_MS : 0;
  const attemptTimeouts = resolveCliBackendAgentAttemptTimeouts();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const payload = await requestWithProviderCapacityRetry(providerId, label, () =>
      request(attemptTimeouts),
    );
    if (!payload) {
      return undefined;
    }
    if (!isCliBackendLiveTimeoutPayload(payload)) {
      return payload;
    }
    if (shouldRetryCliBackendLiveTimeout({ providerId, payload, attempt, maxAttempts })) {
      logCliBackendLiveStep("agent-timeout-retry", { providerId, label, attempt, maxAttempts });
      await sleep(retrySleepMs);
      continue;
    }
    throw new Error(
      `${label} for provider "${providerId}" timed out waiting for a model response.`,
    );
  }
  return undefined;
}

describeLive("gateway live (cli backend)", () => {
  it(
    "runs the agent pipeline against the local CLI backend",
    async () => {
      const preservedEnv = new Set(
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV,
        ) ?? [],
      );
      const previousEnv = snapshotCliBackendLiveEnv();

      clearRuntimeConfigSnapshot();
      applyCliBackendLiveEnv(preservedEnv);
      if (CLI_CACHE_PROBE) {
        // Cache proof crosses the production prepared-runtime and MCP dispatch boundary.
        // Minimal Gateway mode intentionally omits that publication and cannot prove this path.
        setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
      }

      const token = `test-${randomUUID()}`;
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const port = await getCliBackendPortBlock();
      logCliBackendLiveStep("env-ready", { port });

      const rawModel = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL ?? DEFAULT_MODEL;
      const initialParsed = parseModelRef(rawModel, "claude-cli");
      const initialProviderId = initialParsed?.provider ?? "";
      const initialModelKey = initialParsed
        ? `${initialProviderId}/${initialParsed.model}`
        : rawModel;
      const initialModelSwitchTarget = resolveCliModelSwitchProbeTarget(
        initialProviderId,
        initialModelKey,
      );
      const modelSelection = resolveCliBackendLiveModelSelection({
        rawModel,
        defaultProvider: "claude-cli",
        modelSwitchTarget: initialModelSwitchTarget,
      });
      const providerId = modelSelection.providerId;
      const modelKey = modelSelection.cliModelKey;
      const configModelKey = modelSelection.configModelKey;
      const backendResolved = resolveCliBackendConfig(providerId);
      if (CLI_CACHE_PROBE && providerId !== "claude-cli") {
        throw new Error("OPENCLAW_LIVE_CLI_BACKEND_CACHE_PROBE requires provider claude-cli");
      }
      const enableCliImageProbe = !CLI_CACHE_PROBE && shouldRunCliImageProbe(providerId);
      const enableCliMcpProbe = !CLI_CACHE_PROBE && shouldRunCliMcpProbe(providerId);
      const enableCliModelSwitchProbe =
        !CLI_CACHE_PROBE && shouldRunCliModelSwitchProbe(providerId, modelKey);
      const modelSwitchTarget = enableCliModelSwitchProbe
        ? modelSelection.configModelSwitchTarget
        : undefined;
      const sessionKey = "agent:dev:live-cli-backend";
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const memoryNonce = randomBytes(6).toString("hex").toUpperCase();
      const memoryToken = `CLI-MEM-${memoryNonce}`;
      const resumeNonce = randomBytes(3).toString("hex").toUpperCase();
      const enableCliResumeContinuityProbe =
        providerId === "claude-cli" && CLI_RESUME && !CLI_CACHE_PROBE && !modelSwitchTarget;
      const resumeContinuityProbe = enableCliResumeContinuityProbe
        ? buildClaudeCliResumeContinuityProbe({
            firstTurnNonce: nonce,
            resumeNonce,
            memoryToken,
          })
        : undefined;
      logCliBackendLiveStep("model-selected", {
        providerId,
        modelKey,
        configModelKey,
        enableCliImageProbe,
        enableCliMcpProbe,
        enableCliModelSwitchProbe,
        enableCliCacheProbe: CLI_CACHE_PROBE,
        modelSwitchTarget,
      });
      const providerDefaults = backendResolved?.config;

      const cliCommand = process.env.OPENCLAW_LIVE_CLI_BACKEND_COMMAND ?? providerDefaults?.command;
      if (!cliCommand) {
        throw new Error(
          `OPENCLAW_LIVE_CLI_BACKEND_COMMAND is required for provider "${providerId}".`,
        );
      }

      const { args: baseCliArgs, resumeArgs: baseCliResumeArgs } = resolveCliBackendLiveArgs({
        providerId,
        defaultArgs: providerDefaults?.args,
        defaultResumeArgs: providerDefaults?.resumeArgs,
      });

      const cliClearEnv =
        parseJsonStringArray(
          "OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV",
          process.env.OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV,
        ) ??
        providerDefaults?.clearEnv ??
        [];
      const filteredCliClearEnv = cliClearEnv.filter((name) => !preservedEnv.has(name));
      const preservedCliEnv = Object.fromEntries(
        [...preservedEnv]
          .map((name) => [name, process.env[name]])
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const cliImageArg =
        process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG?.trim() || providerDefaults?.imageArg;
      const cliImageMode =
        parseImageMode(process.env.OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE) ??
        providerDefaults?.imageMode;
      if (cliImageMode && !cliImageArg) {
        throw new Error(
          "OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE requires OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG.",
        );
      }
      if (!backendResolved || !providerDefaults) {
        throw new Error(`missing CLI backend metadata for ${providerId}`);
      }
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-cli-"));
      const stateDir = path.join(tempDir, "state");
      await fs.mkdir(stateDir, { recursive: true });
      const schemaProbePlugin =
        CLI_MCP_SCHEMA_PROBE || CLI_CACHE_PROBE
          ? await createMcpSchemaProbePlugin(tempDir)
          : undefined;
      const schemaProbePluginPath = schemaProbePlugin?.pluginPath;
      const useMinimalToolsProfile = providerId === "codex-cli" && !schemaProbePluginPath;
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const bundleMcp = backendResolved.bundleMcp;
      const bootstrapWorkspace = await createBootstrapWorkspace(tempDir);
      if (CLI_CACHE_PROBE) {
        await initializeCacheProbeGitWorkspace(bootstrapWorkspace.workspaceRootDir);
      }
      const disableMcpConfig = process.env.OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG !== "0";
      let cliArgs = baseCliArgs;
      if (
        bundleMcp &&
        disableMcpConfig &&
        backendResolved?.bundleMcpMode === "claude-config-file"
      ) {
        const mcpConfigPath = path.join(tempDir, "claude-mcp.json");
        await fs.writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
        cliArgs = withClaudeMcpConfigOverrides(baseCliArgs, mcpConfigPath);
      }
      const liveBackend = createRuntimeBackendEntry(backendResolved, {
        pluginId: backendResolved.pluginId ?? providerId,
        bundleMcp,
        config: {
          ...providerDefaults,
          command: cliCommand,
          args: cliArgs,
          resumeArgs: baseCliResumeArgs,
          clearEnv: filteredCliClearEnv.length > 0 ? filteredCliClearEnv : undefined,
          env: Object.keys(preservedCliEnv).length > 0 ? preservedCliEnv : undefined,
          systemPromptWhen: providerDefaults.systemPromptWhen ?? "never",
          ...(cliImageArg
            ? {
                imageArg: cliImageArg,
                imageMode: cliImageMode,
                imagePathScope: providerDefaults.imagePathScope,
              }
            : {}),
        },
      });
      if (!CLI_CACHE_PROBE) {
        cliBackendsTesting.setDepsForTest({
          resolvePluginSetupCliBackend: () => undefined,
          resolveRuntimeCliBackends: () => [liveBackend],
        });
      }

      const cfg: OpenClawConfig = {};
      const nextCfg: OpenClawConfig = {
        ...cfg,
        ...(CLI_CACHE_PROBE
          ? {
              auth: {
                profiles: {
                  [CLI_CACHE_AUTH_PROFILE_ID]: { provider: "claude-cli", mode: "api_key" },
                },
                order: { "claude-cli": [CLI_CACHE_AUTH_PROFILE_ID] },
              },
            }
          : {}),
        ...(schemaProbePluginPath || CLI_CACHE_PROBE
          ? {
              plugins: {
                ...cfg.plugins,
                enabled: true,
                // Keep the warm-process tool catalog stable across turns. Unrelated bundled
                // plugin sidecars can otherwise mutate the MCP fingerprint during this proof.
                ...(CLI_CACHE_PROBE
                  ? {
                      slots: { memory: "none" },
                    }
                  : {}),
                ...(schemaProbePluginPath
                  ? {
                      load: {
                        ...cfg.plugins?.load,
                        paths: [...(cfg.plugins?.load?.paths ?? []), schemaProbePluginPath],
                      },
                    }
                  : {}),
                entries: {
                  ...cfg.plugins?.entries,
                  ...(schemaProbePluginPath
                    ? { [MCP_SCHEMA_PROBE_PLUGIN_ID]: { enabled: true } }
                    : {}),
                  ...(CLI_CACHE_PROBE ? { anthropic: { enabled: true } } : {}),
                },
              },
            }
          : {}),
        gateway: {
          mode: "local",
          ...cfg.gateway,
          port,
          auth: { mode: "token", token },
        },
        models:
          providerId === "codex-cli"
            ? {
                ...cfg.models,
                providers: {
                  ...cfg.models?.providers,
                  openai: {
                    ...openAiProviderConfigForCodexCli(configModelKey),
                    ...cfg.models?.providers?.openai,
                  },
                },
              }
            : cfg.models,
        ...(useMinimalToolsProfile
          ? {
              tools: {
                ...cfg.tools,
                profile: "minimal" as const,
              },
            }
          : {}),
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            ...(bootstrapWorkspace ? { workspace: bootstrapWorkspace.workspaceRootDir } : {}),
            ...(CLI_CACHE_PROBE ? { skipBootstrap: true } : {}),
            model: { primary: configModelKey },
            models: {
              [configModelKey]: {
                agentRuntime: modelSelection.agentRuntime,
                ...(CLI_CACHE_PROBE
                  ? { params: { thinking: CLI_CACHE_PROBE_INITIAL_THINKING_LEVEL } }
                  : {}),
              },
              ...(modelSwitchTarget
                ? { [modelSwitchTarget]: { agentRuntime: modelSelection.agentRuntime } }
                : {}),
            },
            sandbox: { mode: "off" },
          },
          // The live requests below use agent:dev:* session keys. Declare the
          // agent so the gateway recognizes those sessions as configured.
          entries: { dev: {} },
        },
      };
      const tempConfigPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);
      const cacheProbeBackend = CLI_CACHE_PROBE
        ? prepareClaudeCacheProbeBackend({ config: nextCfg, liveBackend, providerId })
        : undefined;
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity();
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
      logCliBackendLiveStep("config-written", {
        tempConfigPath,
        stateDir,
        cliCommand,
        cliArgs,
      });

      try {
        server = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        await server.startupSettled;
        logCliBackendLiveStep("server-started");
        if (CLI_CACHE_PROBE) {
          if (!cacheProbeBackend) {
            throw new Error("cache probe lost its loaded runtime CLI backend");
          }
          cliBackendsTesting.setDepsForTest({
            resolvePluginSetupCliBackend: () => undefined,
            resolveRuntimeCliBackends: () => [cacheProbeBackend],
          });
        }
        if (resumeContinuityProbe) {
          const continuityHookRegistry = createMockPluginRegistry([
            {
              pluginId: CLI_CONTINUITY_PROBE_PLUGIN_ID,
              hookName: "before_prompt_build",
              handler: async (event: unknown, ctx: unknown) => {
                const prompt = (event as { prompt?: unknown }).prompt;
                const hookSessionKey = (ctx as { sessionKey?: unknown }).sessionKey;
                if (
                  hookSessionKey !== sessionKey ||
                  typeof prompt !== "string" ||
                  !prompt.includes(resumeContinuityProbe.firstTurnMarker)
                ) {
                  return undefined;
                }
                return { prependContext: resumeContinuityProbe.injectedContext };
              },
            },
          ]);
          initializeGlobalHookRunner(continuityHookRegistry);
          // Keep bundled MCP capture enabled: the generation check below must cover the same
          // delivery-capture process lifetime used by production Claude sessions.
          cliBackendsTesting.setDepsForTest({
            resolveRuntimeCliBackends: () => [
              {
                ...liveBackend,
                pluginId: liveBackend.pluginId ?? CLI_CONTINUITY_PROBE_PLUGIN_ID,
              },
            ],
          });
        }
        client = await connectTestGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          deviceIdentity,
        });
        logCliBackendLiveStep("client-connected");
        const activeClient = client;

        logCliBackendLiveStep("agent-request:start", { sessionKey, nonce });
        const payload = await requestWithCodexTimeoutRetry(
          providerId,
          "agent request",
          (timeouts) =>
            activeClient.request(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${randomUUID()}`,
                message:
                  providerId === "codex-cli"
                    ? `Do not inspect files or run tools. Reply with exactly: CLI-BACKEND-${nonce}.`
                    : resumeContinuityProbe
                      ? resumeContinuityProbe.firstTurnPrompt
                      : enableCliModelSwitchProbe
                        ? `Please include the token CLI-BACKEND-${nonce} in your reply.` +
                          ` Also remember this session note for later: ${memoryToken}.` +
                          " Do not include the note in your reply."
                        : `Please include the token CLI-BACKEND-${nonce} in your reply.`,
                deliver: false,
                timeout: timeouts.agentTimeoutSeconds,
              },
              { expectFinal: true, timeoutMs: timeouts.requestTimeoutMs },
            ),
        );
        if (!payload) {
          return;
        }
        if (payload?.status !== "ok") {
          throw new Error(`agent status=${String(payload?.status)}`);
        }
        logCliBackendLiveStep("agent-request:done", { status: payload?.status });

        let cacheProbeOwner: Parameters<typeof getCliLiveSessionGeneration>[0] | undefined;
        let cacheProbeSteadyGeneration: string | undefined;
        if (CLI_CACHE_PROBE) {
          const history = await activeClient.request<{ sessionId?: string }>("chat.history", {
            sessionKey,
          });
          if (!history.sessionId) {
            throw new Error("Claude CLI cache probe could not resolve its OpenClaw session");
          }
          cacheProbeOwner = {
            backendId: providerId,
            agentId: "dev",
            authProfileId: CLI_CACHE_AUTH_PROFILE_ID,
            sessionId: history.sessionId,
            sessionKey,
          };
        }

        const text = extractPayloadText(payload?.result);
        if (providerId === "codex-cli") {
          expect(text).toContain(`CLI-BACKEND-${nonce}`);
        } else {
          const resultWithMeta = payload?.result as {
            meta?: { systemPromptReport?: SystemPromptReport };
          };
          if (enableCliModelSwitchProbe) {
            expect(text.trim().length).toBeGreaterThan(0);
          } else if (resumeContinuityProbe) {
            expect(matchesCliBackendReply(text, resumeContinuityProbe.expectedFirstReply)).toBe(
              true,
            );
            expect(text).not.toContain(memoryToken);
          } else {
            expect(text).toContain(`CLI-BACKEND-${nonce}`);
          }
          const injectedFileNames =
            resultWithMeta.meta?.systemPromptReport?.injectedWorkspaceFiles?.map(
              (entry) => entry.name,
            ) ?? [];
          if (!CLI_CACHE_PROBE) {
            for (const expectedFile of bootstrapWorkspace?.expectedInjectedFiles ?? []) {
              expect(injectedFileNames).toContain(expectedFile);
            }
          }
        }

        if (modelSwitchTarget) {
          const switchNonce = randomBytes(3).toString("hex").toUpperCase();
          logCliBackendLiveStep("agent-switch:start", {
            sessionKey,
            fromModel: modelKey,
            toModel: modelSwitchTarget,
            switchNonce,
            memoryToken,
          });
          const patchPayload = await activeClient.request("sessions.patch", {
            key: sessionKey,
            model: modelSwitchTarget,
          });
          if (!patchPayload || typeof patchPayload !== "object" || !("ok" in patchPayload)) {
            throw new Error(
              `sessions.patch failed for model switch: ${JSON.stringify(patchPayload)}`,
            );
          }
          const switchPayload = await requestWithCodexTimeoutRetry(
            providerId,
            "agent model-switch request",
            (timeouts) =>
              activeClient.request(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}`,
                  message:
                    "We just switched from Claude Sonnet to Claude Opus in the same session. " +
                    `What session note did I ask you to remember earlier? ` +
                    `Reply with exactly: CLI backend SWITCH OK ${switchNonce} <remembered-note>.`,
                  deliver: false,
                  timeout: timeouts.agentTimeoutSeconds,
                },
                { expectFinal: true, timeoutMs: timeouts.requestTimeoutMs },
              ),
          );
          if (!switchPayload) {
            return;
          }
          if (switchPayload?.status !== "ok") {
            throw new Error(`switch status=${String(switchPayload?.status)}`);
          }
          logCliBackendLiveStep("agent-switch:done", { status: switchPayload?.status });
          const switchText = extractPayloadText(switchPayload?.result);
          expect(
            matchesCliBackendReply(
              switchText,
              `CLI backend SWITCH OK ${switchNonce} ${memoryToken}.`,
            ),
          ).toBe(true);
        } else if (CLI_RESUME) {
          logCliBackendLiveStep("agent-resume:start", { sessionKey, resumeNonce });
          let continuityOwner: Parameters<typeof getCliLiveSessionGeneration>[0] | undefined;
          let expectedLiveSessionGeneration: string | undefined;
          if (resumeContinuityProbe) {
            const nativeHistory = await activeClient.request<{
              messages?: unknown[];
              sessionId?: string;
            }>("chat.history", { sessionKey });
            const cliSessionId = resolveImportedClaudeCliSessionId(nativeHistory.messages ?? []);
            expect(JSON.stringify(nativeHistory.messages ?? [])).toContain(memoryToken);
            expect(cliSessionId).toBeTruthy();
            const continuitySessionId = nativeHistory.sessionId;
            expect(continuitySessionId).toBeTruthy();
            if (!continuitySessionId) {
              throw new Error("Claude CLI continuity probe could not resolve its OpenClaw session");
            }
            continuityOwner = {
              backendId: providerId,
              agentId: "dev",
              sessionId: continuitySessionId,
              sessionKey,
            };
            expectedLiveSessionGeneration = getCliLiveSessionGeneration(continuityOwner);
            expect(expectedLiveSessionGeneration).toBeTruthy();
          }
          const resumePayload = await requestWithCodexTimeoutRetry(
            providerId,
            "agent resume request",
            (timeouts) =>
              activeClient.request(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}`,
                  message:
                    providerId === "codex-cli"
                      ? `Do not inspect files or run tools. Reply with exactly: CLI-RESUME-${resumeNonce}.`
                      : CLI_CACHE_PROBE
                        ? `Call the ${MCP_SCHEMA_PROBE_TOOL_NAME} tool exactly once. Then reply with exactly: CLI-RESUME-${resumeNonce} <tool-result>.`
                        : resumeContinuityProbe
                          ? resumeContinuityProbe.resumePrompt
                          : `Reply with exactly: CLI backend RESUME OK ${resumeNonce}.`,
                  deliver: false,
                  timeout: timeouts.agentTimeoutSeconds,
                },
                { expectFinal: true, timeoutMs: timeouts.requestTimeoutMs },
              ),
          );
          if (!resumePayload) {
            return;
          }
          if (resumePayload?.status !== "ok") {
            throw new Error(`resume status=${String(resumePayload?.status)}`);
          }
          logCliBackendLiveStep("agent-resume:done", { status: resumePayload?.status });
          if (CLI_CACHE_PROBE) {
            logCliCacheUsage("resume1-warmup", resumePayload.result);
            expect(cacheProbeOwner).toBeDefined();
          }
          const resumeText = extractPayloadText(resumePayload?.result);
          if (CLI_CACHE_PROBE) {
            expect(resumeText).toContain(schemaProbePlugin?.resultToken);
          } else if (providerId === "codex-cli") {
            expect(resumeText).toContain(`CLI-RESUME-${resumeNonce}`);
          } else if (resumeContinuityProbe) {
            expect(resumeText).toContain(resumeContinuityProbe.expectedResumeMarker);
            expect(resumeText).toContain(memoryToken);
            if (!continuityOwner || !expectedLiveSessionGeneration) {
              throw new Error("Claude CLI continuity probe lost its live-session generation");
            }
            expect(getCliLiveSessionGeneration(continuityOwner)).toBe(
              expectedLiveSessionGeneration,
            );
          } else {
            expect(
              matchesCliBackendReply(resumeText, `CLI backend RESUME OK ${resumeNonce}.`),
            ).toBe(true);
          }

          if (CLI_CACHE_PROBE) {
            const requestCacheProbeTurn = async (turn: string, marker: string) => {
              logCliBackendLiveStep(`agent-${turn}:start`, { sessionKey, marker });
              const probePayload = await requestWithCodexTimeoutRetry(
                providerId,
                `agent ${turn} request`,
                (timeouts) =>
                  activeClient.request(
                    "agent",
                    {
                      sessionKey,
                      idempotencyKey: `idem-${randomUUID()}`,
                      message: `Do not inspect files or run tools. Reply with exactly: ${marker}.`,
                      deliver: false,
                      timeout: timeouts.agentTimeoutSeconds,
                    },
                    { expectFinal: true, timeoutMs: timeouts.requestTimeoutMs },
                  ),
              );
              if (!probePayload) {
                return undefined;
              }
              if (probePayload.status !== "ok") {
                throw new Error(`${turn} status=${String(probePayload.status)}`);
              }
              logCliBackendLiveStep(`agent-${turn}:done`, { status: probePayload.status });
              expect(extractPayloadText(probePayload.result)).toContain(marker);
              return logCliCacheUsage(turn, probePayload.result);
            };
            const settleNonce = randomBytes(3).toString("hex").toUpperCase();
            const settleHitRate = await requestCacheProbeTurn(
              "resume1-settle",
              `CLI-CACHE-SETTLE-${settleNonce}`,
            );
            if (settleHitRate === undefined) {
              return;
            }
            // The first turn advertises one bootstrap-only tool. Allow the no-tool settle turn to
            // run hot or cold, then capture the steady process after any valid schema rotation.
            cacheProbeSteadyGeneration = getCliLiveSessionGeneration(cacheProbeOwner!);
            expect(cacheProbeSteadyGeneration).toBeTruthy();

            const cacheNonce = randomBytes(3).toString("hex").toUpperCase();
            // Dirty the workspace between captured turns while the compatible Claude flag keeps
            // its native Git-status section out of the stable prompt prefix.
            await fs.writeFile(
              path.join(bootstrapWorkspace.workspaceRootDir, ".claude-cache-git-drift"),
              `${cacheNonce}\n`,
            );
            const cacheHitRate = await requestCacheProbeTurn("resume2", `CLI-CACHE-${cacheNonce}`);
            if (cacheHitRate === undefined) {
              return;
            }
            expect(cacheHitRate).toBeGreaterThanOrEqual(CLI_BACKEND_MIN_CACHE_HIT_RATE);
            expect(getCliLiveSessionGeneration(cacheProbeOwner!)).toBe(cacheProbeSteadyGeneration);

            const thinkingPatchPayload = await activeClient.request("sessions.patch", {
              key: sessionKey,
              thinkingLevel: CLI_CACHE_PROBE_SWITCHED_THINKING_LEVEL,
            });
            if (
              !thinkingPatchPayload ||
              typeof thinkingPatchPayload !== "object" ||
              !("ok" in thinkingPatchPayload) ||
              thinkingPatchPayload.ok !== true
            ) {
              throw new Error("sessions.patch failed for cache probe thinking-level switch");
            }

            const switchNonce = randomBytes(3).toString("hex").toUpperCase();
            const switchProbeResult = await requestCacheProbeTurn(
              "thinking-switch",
              `CLI-THINKING-SWITCH-${switchNonce}`,
            );
            if (switchProbeResult === undefined) {
              return;
            }
            // Thinking changes always invalidate messages and can invalidate tools/system on
            // models that render the thinking configuration ahead of them. Assert the required
            // process rotation here; the following steady turn proves the new prefix is reusable.
            // https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache
            const switchedGeneration = getCliLiveSessionGeneration(cacheProbeOwner!);
            expect(switchedGeneration).toBeTruthy();
            expect(switchedGeneration).not.toBe(cacheProbeSteadyGeneration);

            const steadyNonce = randomBytes(3).toString("hex").toUpperCase();
            const steadyHitRate = await requestCacheProbeTurn(
              "thinking-steady",
              `CLI-THINKING-STEADY-${steadyNonce}`,
            );
            if (steadyHitRate === undefined) {
              return;
            }
            expect(steadyHitRate).toBeGreaterThanOrEqual(CLI_BACKEND_MIN_CACHE_HIT_RATE);
            expect(getCliLiveSessionGeneration(cacheProbeOwner!)).toBe(switchedGeneration);
          }
        }

        if (enableCliImageProbe) {
          const imageSessionKey =
            providerId === "codex-cli"
              ? `agent:dev:live-cli-backend-image:${randomUUID()}`
              : sessionKey;
          logCliBackendLiveStep("image-probe:start", { sessionKey: imageSessionKey });
          await verifyCliBackendImageProbe({
            client: activeClient,
            providerId,
            sessionKey: imageSessionKey,
            tempDir,
            bootstrapWorkspace,
          });
          logCliBackendLiveStep("image-probe:done");
        }

        if (enableCliMcpProbe) {
          logCliBackendLiveStep("cron-mcp-loopback-preflight:start", {
            sessionKey,
          });
          await verifyCliCronMcpLoopbackPreflight({
            sessionKey,
            port,
            token,
            env: process.env,
            expectedSchemaProbeToolName: schemaProbePluginPath
              ? MCP_SCHEMA_PROBE_TOOL_NAME
              : undefined,
          });
          logCliBackendLiveStep("cron-mcp-loopback-preflight:done");
          if (providerId === "codex-cli" && CLI_CI_SAFE_CODEX_CONFIG) {
            logCliBackendLiveStep("cron-mcp-probe:skipped", {
              providerId,
              reason: "ci-safe-codex-config",
            });
          } else {
            logCliBackendLiveStep("cron-mcp-probe:start", { sessionKey });
            await verifyCliCronMcpProbe({
              client: activeClient,
              providerId,
              sessionKey,
              port,
              token,
              env: process.env,
            });
            logCliBackendLiveStep("cron-mcp-probe:done");
          }
        }
      } finally {
        try {
          logCliBackendLiveStep("cleanup:start");
          clearRuntimeConfigSnapshot();
          try {
            await client?.stopAndWait();
          } finally {
            await server?.close();
          }
        } finally {
          cliBackendsTesting.resetDepsForTest();
          resetGlobalHookRunner();
          await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          restoreCliBackendLiveEnv(previousEnv);
          logCliBackendLiveStep("cleanup:done");
        }
      }
    },
    CLI_BACKEND_LIVE_TIMEOUT_MS,
  );
});
