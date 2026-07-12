// CLI backend live gateway tests exercise configured backend sessions, model switching, MCP loopback, and image probes.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  testing as cliBackendsTesting,
  resolveCliBackendConfig,
  resolveCliBackendLiveTest,
} from "../agents/cli-backends.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { shouldSkipLiveProviderDrift } from "../agents/live-test-provider-drift.js";
import { parseModelRef } from "../agents/model-selection.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugin-sdk/testing.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { resolveClaudeCliSessionFilePath } from "./cli-session-history.js";
import {
  applyCliBackendLiveEnv,
  buildClaudeCliResumeContinuityProbe,
  createBootstrapWorkspace,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
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
const CLI_RESUME = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE);
const CLI_DEBUG = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG);
const CLI_CI_SAFE_CODEX_CONFIG = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_CLI_BACKEND_USE_CI_SAFE_CODEX_CONFIG,
);
const CLI_MCP_SCHEMA_PROBE = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_CLI_BACKEND_MCP_SCHEMA_PROBE,
);
const CLI_ALLOW_PROVIDER_SKIP = shouldAllowCliBackendLiveProviderSkip();
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const MCP_SCHEMA_PROBE_PLUGIN_ID = "mcp-schema-probe";
const MCP_SCHEMA_PROBE_TOOL_NAME = "mcp_schema_probe_no_args";
const CLI_CONTINUITY_PROBE_PLUGIN_ID = "cli-continuity-probe";

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

async function createMcpSchemaProbePlugin(tempDir: string): Promise<string> {
  const pluginDir = path.join(tempDir, MCP_SCHEMA_PROBE_PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.cjs");
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: MCP_SCHEMA_PROBE_PLUGIN_ID,
        name: "MCP Schema Probe",
        description: "Live test plugin for no-argument MCP tool schemas",
        configSchema: { type: "object", properties: {} },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    pluginFile,
    `module.exports = {
  id: "${MCP_SCHEMA_PROBE_PLUGIN_ID}",
  name: "MCP Schema Probe",
  register(api) {
    api.registerTool({
      name: "${MCP_SCHEMA_PROBE_TOOL_NAME}",
      description: "Live test no-argument tool for MCP schema normalization",
      parameters: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: "schema probe ok" }] };
      },
    });
  },
};
`,
  );
  return pluginFile;
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

      const token = `test-${randomUUID()}`;
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const port = await getFreeGatewayPort();
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
      const enableCliImageProbe = shouldRunCliImageProbe(providerId);
      const enableCliMcpProbe = shouldRunCliMcpProbe(providerId);
      const enableCliModelSwitchProbe = shouldRunCliModelSwitchProbe(providerId, modelKey);
      const modelSwitchTarget = enableCliModelSwitchProbe
        ? modelSelection.configModelSwitchTarget
        : undefined;
      const sessionKey = "agent:dev:live-cli-backend";
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const memoryNonce = randomBytes(6).toString("hex").toUpperCase();
      const memoryToken = `CLI-MEM-${memoryNonce}`;
      const resumeNonce = randomBytes(3).toString("hex").toUpperCase();
      const enableCliResumeContinuityProbe =
        providerId === "claude-cli" && CLI_RESUME && !modelSwitchTarget;
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

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-cli-"));
      const stateDir = path.join(tempDir, "state");
      await fs.mkdir(stateDir, { recursive: true });
      const schemaProbePluginPath = CLI_MCP_SCHEMA_PROBE
        ? await createMcpSchemaProbePlugin(tempDir)
        : undefined;
      const useMinimalToolsProfile = providerId === "codex-cli" && !schemaProbePluginPath;
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const bundleMcp = backendResolved?.bundleMcp === true && !resumeContinuityProbe;
      const bootstrapWorkspace = await createBootstrapWorkspace(tempDir);
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

      const cfg: OpenClawConfig = {};
      const cfgWithCliBackends = cfg as OpenClawConfig & {
        agents?: {
          defaults?: {
            cliBackends?: Record<string, Record<string, unknown>>;
          };
        };
      };
      const existingBackends = cfgWithCliBackends.agents?.defaults?.cliBackends ?? {};
      const nextCfg = {
        ...cfg,
        ...(schemaProbePluginPath
          ? {
              plugins: {
                ...cfg.plugins,
                load: {
                  ...cfg.plugins?.load,
                  paths: [...(cfg.plugins?.load?.paths ?? []), schemaProbePluginPath],
                },
                entries: {
                  ...cfg.plugins?.entries,
                  [MCP_SCHEMA_PROBE_PLUGIN_ID]: { enabled: true },
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
            model: { primary: configModelKey },
            models: {
              [configModelKey]: { agentRuntime: modelSelection.agentRuntime },
              ...(modelSwitchTarget
                ? { [modelSwitchTarget]: { agentRuntime: modelSelection.agentRuntime } }
                : {}),
            },
            cliBackends: {
              ...existingBackends,
              [providerId]: {
                command: cliCommand,
                args: cliArgs,
                resumeArgs: baseCliResumeArgs,
                clearEnv: filteredCliClearEnv.length > 0 ? filteredCliClearEnv : undefined,
                env: Object.keys(preservedCliEnv).length > 0 ? preservedCliEnv : undefined,
                systemPromptWhen: providerDefaults?.systemPromptWhen ?? "never",
                ...(cliImageArg
                  ? {
                      imageArg: cliImageArg,
                      imageMode: cliImageMode,
                      imagePathScope: providerDefaults?.imagePathScope,
                    }
                  : {}),
              },
            },
            sandbox: { mode: "off" },
          },
          // The live requests below use agent:dev:* session keys. Declare the
          // agent so the gateway recognizes those sessions as configured.
          list: [{ id: "dev", default: true }],
        },
      };
      const tempConfigPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);
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
        logCliBackendLiveStep("server-started");
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
          // Bundled MCP capture intentionally retires a Claude child after each turn. This probe
          // isolates the exact warm-session path while leaving production defaults untouched.
          if (!backendResolved) {
            throw new Error(`missing CLI backend metadata for ${providerId}`);
          }
          cliBackendsTesting.setDepsForTest({
            resolveRuntimeCliBackends: () => [
              {
                ...backendResolved,
                pluginId: backendResolved.pluginId ?? CLI_CONTINUITY_PROBE_PLUGIN_ID,
                bundleMcp: false,
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
          for (const expectedFile of bootstrapWorkspace?.expectedInjectedFiles ?? []) {
            expect(injectedFileNames).toContain(expectedFile);
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
          if (resumeContinuityProbe) {
            const nativeHistory = await activeClient.request<{ messages?: unknown[] }>(
              "chat.history",
              { sessionKey },
            );
            const cliSessionId = resolveImportedClaudeCliSessionId(nativeHistory.messages ?? []);
            expect(JSON.stringify(nativeHistory.messages ?? [])).toContain(memoryToken);
            expect(cliSessionId).toBeTruthy();
            const cliSessionFile = cliSessionId
              ? resolveClaudeCliSessionFilePath({ cliSessionId })
              : undefined;
            expect(cliSessionFile).toBeTruthy();
            if (!cliSessionFile) {
              throw new Error("Claude CLI continuity probe could not locate its native transcript");
            }
            // The warm child keeps this turn in memory. Remove Claude's native transcript so
            // --resume and raw-history reseed cannot recover the hidden note if that child is lost.
            await fs.rm(cliSessionFile, { force: true });
            const rawHistory = await activeClient.request<{ messages?: unknown[] }>(
              "chat.history",
              { sessionKey },
            );
            expect(JSON.stringify(rawHistory.messages ?? [])).not.toContain(memoryToken);
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
          const resumeText = extractPayloadText(resumePayload?.result);
          if (providerId === "codex-cli") {
            expect(resumeText).toContain(`CLI-RESUME-${resumeNonce}`);
          } else if (resumeContinuityProbe) {
            expect(
              matchesCliBackendReply(resumeText, resumeContinuityProbe.expectedResumeReply),
            ).toBe(true);
          } else {
            expect(
              matchesCliBackendReply(resumeText, `CLI backend RESUME OK ${resumeNonce}.`),
            ).toBe(true);
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
