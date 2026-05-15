import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliBackendConfig, resolveCliBackendLiveTest } from "../agents/cli-backends.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { shouldSkipLiveProviderDrift } from "../agents/live-test-provider-drift.js";
import { parseModelRef } from "../agents/model-selection.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  applyCliBackendLiveEnv,
  createBootstrapWorkspace,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
  matchesCliBackendReply,
  parseImageMode,
  resolveCliModelSwitchProbeTarget,
  resolveCliBackendLiveArgs,
  resolveCliBackendLiveModelSelection,
  parseJsonStringArray,
  restoreCliBackendLiveEnv,
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
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const MCP_SCHEMA_PROBE_PLUGIN_ID = "mcp-schema-probe";
const MCP_SCHEMA_PROBE_TOOL_NAME = "mcp_schema_probe_no_args";

const DEFAULT_PROVIDER = "claude-cli";
const DEFAULT_MODEL =
  resolveCliBackendLiveTest(DEFAULT_PROVIDER)?.defaultModelRef ?? "claude-cli/claude-sonnet-4-6";
// The cron/MCP live probe now tolerates more cancelled tool-call retries in CI,
// so the outer test budget needs enough headroom to finish those retries.
const CLI_BACKEND_LIVE_TIMEOUT_MS = 20 * 60_000;
const CLI_BACKEND_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv(
  "OPENCLAW_LIVE_CLI_BACKEND_REQUEST_TIMEOUT_MS",
  15 * 60_000,
);
const CLI_BACKEND_AGENT_TIMEOUT_SECONDS = Math.max(
  1,
  Math.ceil(CLI_BACKEND_REQUEST_TIMEOUT_MS / 1000) - 10,
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openAiProviderConfigForCodexCli(
  modelKey: string,
): NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>["openai"] {
  const parsed = parseModelRef(modelKey, DEFAULT_PROVIDER);
  const modelId = parsed?.model?.trim() || "gpt-5.5";
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
        if (
          shouldSkipLiveProviderDrift({
            error,
            allowAuth: true,
            allowBilling: true,
          })
        ) {
          console.warn(`SKIP: ${label} skipped because provider account/auth drift blocked it.`);
          return undefined;
        }
        if (providerId === "claude-cli" && isProviderCapacityError(error)) {
          console.warn(`SKIP: ${label} skipped because Claude API stayed overloaded.`);
          return undefined;
        }
        throw error;
      }
      logCliBackendLiveStep("provider-capacity-retry", { label, attempt });
      await sleep(15_000 * attempt);
    }
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
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
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
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const bundleMcp = backendResolved?.bundleMcp === true;
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
              [configModelKey]: {},
              ...(modelSwitchTarget ? { [modelSwitchTarget]: {} } : {}),
            },
            agentRuntime: modelSelection.agentRuntime,
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
        },
      };
      const tempConfigPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity();
      logCliBackendLiveStep("config-written", {
        tempConfigPath,
        stateDir,
        cliCommand,
        cliArgs,
      });

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      logCliBackendLiveStep("server-started");
      const client = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        deviceIdentity,
      });
      logCliBackendLiveStep("client-connected");

      try {
        const sessionKey = "agent:dev:live-cli-backend";
        const nonce = randomBytes(3).toString("hex").toUpperCase();
        const memoryNonce = randomBytes(3).toString("hex").toUpperCase();
        const memoryToken = `CLI-MEM-${memoryNonce}`;
        logCliBackendLiveStep("agent-request:start", { sessionKey, nonce });
        const payload = await requestWithProviderCapacityRetry(providerId, "agent request", () =>
          client.request(
            "agent",
            {
              sessionKey,
              idempotencyKey: `idem-${randomUUID()}`,
              message:
                providerId === "codex-cli"
                  ? `Do not inspect files or run tools. Reply with exactly: CLI-BACKEND-${nonce}.`
                  : enableCliModelSwitchProbe
                    ? `Please include the token CLI-BACKEND-${nonce} in your reply.` +
                      ` Also remember this session note for later: ${memoryToken}.` +
                      " Do not include the note in your reply."
                    : `Please include the token CLI-BACKEND-${nonce} in your reply.`,
              deliver: false,
              timeout: CLI_BACKEND_AGENT_TIMEOUT_SECONDS,
            },
            { expectFinal: true, timeoutMs: CLI_BACKEND_REQUEST_TIMEOUT_MS },
          ),
        );
        if (!payload) {
          return;
        }
        if (providerId === "codex-cli" && payload?.status === "timeout") {
          console.warn(
            "SKIP: Codex CLI backend live smoke timed out waiting for a model response.",
          );
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
          const patchPayload = await client.request("sessions.patch", {
            key: sessionKey,
            model: modelSwitchTarget,
          });
          if (!patchPayload || typeof patchPayload !== "object" || !("ok" in patchPayload)) {
            throw new Error(
              `sessions.patch failed for model switch: ${JSON.stringify(patchPayload)}`,
            );
          }
          const switchPayload = await requestWithProviderCapacityRetry(
            providerId,
            "agent model-switch request",
            () =>
              client.request(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}`,
                  message:
                    "We just switched from Claude Sonnet to Claude Opus in the same session. " +
                    `What session note did I ask you to remember earlier? ` +
                    `Reply with exactly: CLI backend SWITCH OK ${switchNonce} <remembered-note>.`,
                  deliver: false,
                  timeout: CLI_BACKEND_AGENT_TIMEOUT_SECONDS,
                },
                { expectFinal: true, timeoutMs: CLI_BACKEND_REQUEST_TIMEOUT_MS },
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
          const resumeNonce = randomBytes(3).toString("hex").toUpperCase();
          logCliBackendLiveStep("agent-resume:start", { sessionKey, resumeNonce });
          const resumePayload = await requestWithProviderCapacityRetry(
            providerId,
            "agent resume request",
            () =>
              client.request(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}`,
                  message:
                    providerId === "codex-cli"
                      ? `Do not inspect files or run tools. Reply with exactly: CLI-RESUME-${resumeNonce}.`
                      : `Reply with exactly: CLI backend RESUME OK ${resumeNonce}.`,
                  deliver: false,
                  timeout: CLI_BACKEND_AGENT_TIMEOUT_SECONDS,
                },
                { expectFinal: true, timeoutMs: CLI_BACKEND_REQUEST_TIMEOUT_MS },
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
            client,
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
            senderIsOwner: true,
          });
          await verifyCliCronMcpLoopbackPreflight({
            sessionKey,
            port,
            token,
            env: process.env,
            senderIsOwner: true,
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
              client,
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
        logCliBackendLiveStep("cleanup:start");
        clearRuntimeConfigSnapshot();
        await client.stopAndWait();
        await server.close();
        await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        restoreCliBackendLiveEnv(previousEnv);
        logCliBackendLiveStep("cleanup:done");
      }
    },
    CLI_BACKEND_LIVE_TIMEOUT_MS,
  );
});
