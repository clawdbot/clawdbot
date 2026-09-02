import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  createQaBundledPluginsDir,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaRuntimeHostVersion,
  resolveQaStagedBundledPluginsRoot,
} from "./bundled-plugin-staging.js";
import {
  resolveQaGatewayChildCommand,
  runQaGatewayCliCommand,
  type QaGatewayChildCommand,
} from "./gateway-child-command.js";
import {
  buildQaForcedRuntimeEnvPatch,
  buildQaRuntimeEnv,
  stageQaCodexMockModelCatalog,
} from "./gateway-child-env.js";
import type { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { createQaGatewayChildLogCollector } from "./gateway-child-process.js";
import { createQaGatewayCliError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import { reserveQaGatewayPort } from "./gateway-port-reservation.js";
import { createQaGatewayProcessBoundaryController } from "./gateway-process-boundary.js";
import { splitQaModelRef, type QaProviderMode } from "./model-selection.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import type { QaCliBackendAuthMode } from "./providers/env.js";
import { DEFAULT_QA_PROVIDER_MODE, getQaProvider } from "./providers/index.js";
import { readQaLiveProviderConfigOverrides } from "./providers/live-config.js";
import {
  assertQaLiveCodexAuthAvailable,
  stageQaLiveApiKeyProfiles,
  stageQaLiveAnthropicSetupToken,
} from "./providers/live-frontier/auth.js";
import {
  applyQaMockAuthProfileConfig,
  buildQaMockProfileId,
  stageQaMockAuthProfiles,
} from "./providers/shared/mock-auth.js";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { buildQaGatewayConfig, type QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { RuntimeId } from "./runtime-parity.js";
export type QaGatewayChildStateMutationContext = {
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
  stateDir: string;
  tempRoot: string;
};

export type QaGatewayChildListeningContext = {
  attempt: number;
  baseUrl: string;
  wsUrl: string;
  token: string;
  configPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
};

export type QaGatewayChildParams = {
  repoRoot: string;
  command?: QaGatewayChildCommand;
  useRepoCli?: boolean;
  providerBaseUrl?: string;
  transport?: Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
  transportBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode?: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  forcedRuntime?: RuntimeId;
  codexMockAutoCompactTokenLimit?: number;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  enabledPluginIds?: string[];
  allowUnhealthyStartup?: boolean;
  forwardHostHome?: boolean;
  mockAuthAgentIds?: readonly string[];
  onListening?: (context: QaGatewayChildListeningContext) => Promise<void> | void;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
  runtimeEnvPatch?: NodeJS.ProcessEnv;
};

function createQaGatewayEmptyTransport() {
  return {
    requiredPluginIds: [] as const,
    createGatewayConfig: () => ({}),
  } satisfies Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
}

function resolveQaControlUiRoot(params: { repoRoot: string; controlUiEnabled?: boolean }) {
  if (params.controlUiEnabled === false) {
    return undefined;
  }
  const controlUiRoot = path.join(params.repoRoot, "dist", "control-ui");
  const indexPath = path.join(controlUiRoot, "index.html");
  return existsSync(indexPath) ? controlUiRoot : undefined;
}

function createQaPackagedMockApiKey(): string {
  const prefix = ["s", "k"].join("");
  return `${prefix}-${["qa", "mock", randomUUID().replaceAll("-", "")].join("-")}`;
}

async function runQaPackagedBootstrap<T>(
  failureMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const details = createQaGatewayCliError(error).message;
    // oxlint-disable-next-line preserve-caught-error -- Candidate CLI output can contain credentials; only the bounded redacted message crosses this boundary, never its raw cause.
    throw new Error(`${failureMessage}: ${details}`);
  }
}

async function stageQaPackagedMockAuthProfiles(params: {
  lifetime: QaGatewayChildLifecycle;
  command: QaGatewayChildCommand;
  configPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providers: readonly string[];
}): Promise<void> {
  for (const provider of uniqueStrings(params.providers)) {
    await runQaPackagedBootstrap(
      `installed package mock auth bootstrap failed for ${provider}`,
      () =>
        runQaGatewayCliCommand({
          lifetime: params.lifetime,
          executablePath: params.command.executablePath,
          argsPrefix: params.command.argsPrefix ?? [],
          args: [
            "models",
            "auth",
            "--agent",
            "qa",
            "paste-api-key",
            "--provider",
            provider,
            "--profile-id",
            buildQaMockProfileId(provider),
          ],
          cwd: params.command.cwd ?? params.cwd,
          env: { ...params.env, OPENCLAW_CONFIG_PATH: params.configPath },
          stdin: `${createQaPackagedMockApiKey()}\n`,
        }),
    );
  }
}

export async function prepareQaGatewayChild(
  params: QaGatewayChildParams,
  lifetime: QaGatewayChildLifecycle,
) {
  const tempParentDir = params.command?.tempParentDir ?? resolvePreferredOpenClawTmpDir();
  const tempRoot = await fs.mkdtemp(path.join(tempParentDir, "openclaw-qa-suite-"));
  lifetime.tempRoot = tempRoot;
  const runtimeCwd = tempRoot;
  const distEntryPath = path.join(params.repoRoot, "dist", "index.js");
  const gatewayCommand =
    params.command ??
    (params.useRepoCli ? resolveQaGatewayChildCommand(params.repoRoot) : undefined);
  const usesPackagedCandidate = params.command?.usePackagedPlugins === true;
  const gatewayExecutablePath = gatewayCommand?.executablePath;
  const gatewayArgsPrefix = gatewayCommand?.argsPrefix ?? [];
  const gatewayArgsSuffix = gatewayCommand?.argsSuffix ?? [];
  const gatewayCwd = gatewayCommand?.cwd ?? runtimeCwd;
  const workspaceDir = path.join(tempRoot, "workspace");
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const xdgConfigHome = path.join(tempRoot, "xdg-config");
  const xdgDataHome = path.join(tempRoot, "xdg-data");
  const xdgCacheHome = path.join(tempRoot, "xdg-cache");
  const configPath = path.join(tempRoot, "openclaw.json");
  const packagedAuthConfigPath = path.join(stateDir, "qa-auth-bootstrap", "openclaw.json");
  const gatewayToken = `qa-suite-${randomUUID()}`;
  const transport = params.transport ?? createQaGatewayEmptyTransport();
  await seedQaAgentWorkspace({
    workspaceDir,
    repoRoot: params.repoRoot,
  });
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
    fs.mkdir(xdgConfigHome, { recursive: true }),
    fs.mkdir(xdgDataHome, { recursive: true }),
    fs.mkdir(xdgCacheHome, { recursive: true }),
  ]);
  const providerMode = params.providerMode ?? DEFAULT_QA_PROVIDER_MODE;
  const codexModelCatalogPath = await stageQaCodexMockModelCatalog({
    tempRoot,
    forcedRuntime: params.forcedRuntime,
    providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    autoCompactTokenLimit: params.codexMockAutoCompactTokenLimit,
  });
  const resolvedProvider = getQaProvider(providerMode);
  const liveProviderIds = resolvedProvider.usesModelProviderPlugins
    ? [params.primaryModel, params.alternateModel]
        .map((modelRef) =>
          typeof modelRef === "string" ? splitQaModelRef(modelRef)?.provider : undefined,
        )
        .filter((providerId): providerId is string => Boolean(providerId))
    : [];
  const liveProviderConfigs = await readQaLiveProviderConfigOverrides({
    providerIds: liveProviderIds,
  });
  const liveOwnerPluginIds =
    liveProviderIds.length > 0
      ? await resolveQaOwnerPluginIdsForProviderIds({
          repoRoot: params.repoRoot,
          providerIds: liveProviderIds,
          providerConfigs: liveProviderConfigs,
        })
      : [];
  const enabledPluginIds = [
    ...new Set([...(liveOwnerPluginIds ?? []), ...(params.enabledPluginIds ?? [])]),
  ];
  const buildGatewayConfig = (gatewayPort: number) =>
    buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort,
      gatewayToken,
      providerBaseUrl: params.providerBaseUrl,
      workspaceDir,
      controlUiRoot: resolveQaControlUiRoot({
        repoRoot: params.repoRoot,
        controlUiEnabled: params.controlUiEnabled,
      }),
      controlUiAllowedOrigins: params.controlUiAllowedOrigins,
      providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      enabledPluginIds,
      transportPluginIds: transport.requiredPluginIds,
      transportConfig: transport.createGatewayConfig({
        baseUrl: params.transportBaseUrl,
      }),
      liveProviderConfigs,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
      forcedRuntime: params.forcedRuntime,
      controlUiEnabled: params.controlUiEnabled,
    });
  const buildStagedGatewayConfig = async (gatewayPort: number) => {
    let cfg = buildGatewayConfig(gatewayPort);
    cfg = await stageQaLiveApiKeyProfiles({
      cfg,
      stateDir,
      providerIds: liveProviderIds,
    });
    cfg = await stageQaLiveAnthropicSetupToken({
      cfg,
      stateDir,
    });
    const mockAuthProviders = getQaProvider(providerMode).mockAuthProviders;
    if (mockAuthProviders && mockAuthProviders.length > 0) {
      if (usesPackagedCandidate) {
        cfg = applyQaMockAuthProfileConfig({ cfg, providers: mockAuthProviders });
      } else {
        cfg = await stageQaMockAuthProfiles({
          cfg,
          stateDir,
          agentIds: params.mockAuthAgentIds,
          providers: mockAuthProviders,
        });
      }
    }
    return params.mutateConfig ? params.mutateConfig(cfg) : cfg;
  };
  const output = createQaGatewayChildLogCollector();
  const stdoutLogPath = path.join(tempRoot, "gateway.stdout.log");
  const stderrLogPath = path.join(tempRoot, "gateway.stderr.log");
  const stdoutLog = createWriteStream(stdoutLogPath, { flags: "a" });
  lifetime.logStreams.push(["stdout", stdoutLog]);
  const stderrLog = createWriteStream(stderrLogPath, { flags: "a" });
  lifetime.logStreams.push(["stderr", stderrLog]);

  const logs = () => redactQaGatewayDebugText(output.text());
  let gatewayPort = 0;
  let baseUrl = "";
  let wsUrl = "";
  let cfg!: OpenClawConfig;
  let env: NodeJS.ProcessEnv | null = null;
  let packagedMockAuthStaged = false;

  const nodeExecPath = gatewayExecutablePath ?? (await resolveQaNodeExecPath());
  const cliArgsPrefix = gatewayExecutablePath
    ? gatewayArgsPrefix
    : [distEntryPath, ...gatewayArgsPrefix];
  const buildGatewayArgs = () => [
    ...cliArgsPrefix,
    "gateway",
    "run",
    "--port",
    String(gatewayPort),
    "--bind",
    "loopback",
    "--allow-unconfigured",
    ...gatewayArgsSuffix,
  ];
  lifetime.controller = gatewayCommand?.processBoundary
    ? await createQaGatewayProcessBoundaryController({
        config: gatewayCommand.processBoundary,
        launcherPath: nodeExecPath,
        tempRoot,
      })
    : null;
  return {
    output,
    logs,
    stdoutLog,
    stderrLog,
    nodeExecPath,
    gatewayCwd,
    cliArgsPrefix,
    workspaceDir,
    stateDir,
    tempRoot,
    configPath,
    gatewayToken,
    buildGatewayArgs,
    async prepareAttempt(reuseStartupLaunchState: boolean) {
      lifetime.assertOpen();
      if (!reuseStartupLaunchState) {
        lifetime.portReservation = await reserveQaGatewayPort(net.createServer());
        gatewayPort = lifetime.portReservation.port;
        baseUrl = `http://127.0.0.1:${gatewayPort}`;
        wsUrl = `ws://127.0.0.1:${gatewayPort}`;
        cfg = await buildStagedGatewayConfig(gatewayPort);
        if (!env) {
          const allowedPluginIds = uniqueStrings(
            [...(cfg.plugins?.allow ?? []), "openai"].filter(
              (pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0,
            ),
          );
          if (!gatewayCommand?.usePackagedPlugins) {
            // Register the external root before staging so one lifecycle owner
            // also cleans partial copies and host-version resolution failures.
            lifetime.stagedBundledPluginsRoot = resolveQaStagedBundledPluginsRoot({
              repoRoot: params.repoRoot,
              tempRoot,
            });
          }
          const stagedPluginRuntime = gatewayCommand?.usePackagedPlugins
            ? { bundledPluginsDir: undefined, runtimeHostVersion: undefined }
            : {
                ...(await createQaBundledPluginsDir({
                  repoRoot: params.repoRoot,
                  tempRoot,
                  allowedPluginIds,
                })),
                runtimeHostVersion: await resolveQaRuntimeHostVersion({
                  repoRoot: params.repoRoot,
                  allowedPluginIds,
                }),
              };
          env = buildQaRuntimeEnv({
            configPath,
            gatewayToken,
            homeDir,
            forwardHostHome: params.forwardHostHome,
            stateDir,
            tempRoot,
            xdgConfigHome,
            xdgDataHome,
            xdgCacheHome,
            bundledPluginsDir: stagedPluginRuntime.bundledPluginsDir,
            stagedBundledPluginsRoot: lifetime.stagedBundledPluginsRoot,
            compatibilityHostVersion: stagedPluginRuntime.runtimeHostVersion,
            providerMode,
            runtimeEnvPatch: {
              ...params.runtimeEnvPatch,
              ...buildQaForcedRuntimeEnvPatch({
                forcedRuntime: params.forcedRuntime,
                providerMode,
                providerBaseUrl: params.providerBaseUrl,
                codexModelCatalogPath,
                nativeAppServerArgs:
                  params.runtimeEnvPatch?.OPENCLAW_CODEX_APP_SERVER_ARGS ??
                  process.env.OPENCLAW_CODEX_APP_SERVER_ARGS,
              }),
            },
            forwardHostHomeForClaudeCli: liveProviderIds.includes("claude-cli"),
            claudeCliAuthMode: params.claudeCliAuthMode,
          });
        }
        if (!env) {
          throw new Error("qa gateway runtime env not initialized");
        }
        assertQaLiveCodexAuthAvailable({
          cfg,
          providerIds: liveProviderIds,
          env,
        });
        await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        const mockAuthProviders = getQaProvider(providerMode).mockAuthProviders;
        if (
          usesPackagedCandidate &&
          gatewayCommand &&
          mockAuthProviders?.length &&
          !packagedMockAuthStaged
        ) {
          const canonicalConfig = await fs.readFile(configPath);
          await fs.mkdir(path.dirname(packagedAuthConfigPath), { recursive: true, mode: 0o700 });
          await fs.writeFile(packagedAuthConfigPath, canonicalConfig, {
            flag: "wx",
            mode: 0o600,
          });
          await stageQaPackagedMockAuthProfiles({
            lifetime,
            command: gatewayCommand,
            configPath: packagedAuthConfigPath,
            cwd: gatewayCwd,
            env,
            providers: mockAuthProviders,
          });
          if (!canonicalConfig.equals(await fs.readFile(configPath))) {
            throw new Error("installed package mock auth bootstrap mutated canonical config");
          }
          packagedMockAuthStaged = true;
        }
        if (usesPackagedCandidate && gatewayCommand) {
          const command = {
            lifetime,
            executablePath: gatewayCommand.executablePath,
            argsPrefix: gatewayCommand.argsPrefix ?? [],
            cwd: gatewayCwd,
            env,
          };
          // The separate onboarding smoke cannot prepare this child's state.
          // Converge every freshly written config; a new-port retry can otherwise
          // restore plugin entries the candidate removed before verify-only startup.
          // Published candidates such as 2026.7.1-2 predate capability consent.
          const help = await runQaPackagedBootstrap(
            "installed package plugin setup failed (update repair --help)",
            () => runQaGatewayCliCommand({ ...command, args: ["update", "repair", "--help"] }),
          );
          const consentArgs = help.includes("--accept-capabilities")
            ? ["--accept-capabilities"]
            : [];
          await runQaPackagedBootstrap(
            "installed package plugin setup failed (update repair)",
            () =>
              runQaGatewayCliCommand({
                ...command,
                args: ["update", "repair", ...consentArgs, "--yes", "--no-restart", "--json"],
              }),
          );
        }
      }
      if (!env) {
        throw new Error("qa gateway runtime env not initialized");
      }

      await lifetime.portReservation?.release();
      lifetime.portReservation = null;
      lifetime.assertOpen();
      return { cfg, env, gatewayPort, baseUrl, wsUrl };
    },
  };
}
