// Qa Lab plugin module implements gateway child behavior.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  createQaBundledPluginsDir,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaRuntimeHostVersion,
  resolveQaStagedBundledPluginsRoot,
} from "./bundled-plugin-staging.js";
import { QaSuiteInfraError } from "./errors.js";
import {
  cleanupQaGatewayTempRoots,
  preserveQaGatewayDebugArtifacts,
} from "./gateway-child-artifacts.js";
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
import {
  closeQaGatewayLogStream,
  createQaGatewayChildLogCollector,
  formatQaGatewayProcessBoundaryStartupFailure,
  monitorQaGatewayChildFailure,
  stopQaGatewayChildProcessTree,
  throwQaGatewayChildFailure,
  type QaChildFailure,
} from "./gateway-child-process.js";
import {
  callQaGatewayWithRetry,
  isRetryableRpcStartupError,
  QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS,
  resolveQaGatewayStartupRetry,
  waitForGatewayListening,
  waitForGatewayReady,
  waitForQaGatewayRestartBoundary,
} from "./gateway-child-readiness.js";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import { reserveQaGatewayPort } from "./gateway-port-reservation.js";
import {
  createQaGatewayProcessBoundaryController,
  type QaGatewayVerifiedProcessIdentity,
} from "./gateway-process-boundary.js";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { splitQaModelRef, type QaProviderMode } from "./model-selection.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { readProcessTreeCpuMs, readProcessTreeRssBytes } from "./process-tree-cpu.js";
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

export type { QaGatewayChildCommand } from "./gateway-child-command.js";
export type { QaCliBackendAuthMode } from "./providers/env.js";
const QA_GATEWAY_CHILD_RPC_STARTUP_TIMEOUT_MS = 30_000;
const QA_GATEWAY_CHILD_RPC_RETRY_HEALTH_TIMEOUT_MS = 60_000;
const QA_PACKAGE_AUTH_FAILURE_MAX_CHARS = 2_048;

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

function createQaGatewayEmptyTransport() {
  return {
    requiredPluginIds: [] as const,
    createGatewayConfig: () => ({}),
  } satisfies Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
}

function appendQaGatewayTempRoot(details: string, tempRoot: string) {
  return details.includes(tempRoot)
    ? details
    : `${details}\nQA gateway temp root preserved at ${tempRoot}`;
}

function throwQaGatewayStartupError(params: {
  error: unknown;
  message: string;
  cleanupErrors: unknown[];
}): never {
  const primaryError =
    params.error instanceof QaSuiteInfraError
      ? new QaSuiteInfraError(params.error.code, params.message, { cause: params.error })
      : new Error(params.message, { cause: params.error });
  if (params.cleanupErrors.length === 0) {
    throw primaryError;
  }
  throw new AggregateError(
    [primaryError, ...params.cleanupErrors],
    "qa gateway startup and cleanup failed",
    { cause: primaryError },
  );
}

type QaGatewayProcessBoundaryController = Awaited<
  ReturnType<typeof createQaGatewayProcessBoundaryController>
>;

async function stopQaGatewayChildWithBoundary(params: {
  child: ChildProcess;
  controller: QaGatewayProcessBoundaryController | null;
  identity: QaGatewayVerifiedProcessIdentity | null;
  opts?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number };
}) {
  const errors: unknown[] = [];
  if (params.controller && params.identity) {
    try {
      await params.controller.markExited(params.identity);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await stopQaGatewayChildProcessTree(params.child, params.opts);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "qa gateway process-boundary cleanup failed");
  }
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

async function stageQaPackagedMockAuthProfiles(params: {
  command: QaGatewayChildCommand;
  configPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providers: readonly string[];
}): Promise<void> {
  for (const provider of uniqueStrings(params.providers)) {
    try {
      await runQaGatewayCliCommand({
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
      });
    } catch (error) {
      const errorMessage = toErrorObject(error, "installed package auth command failed").message;
      const details = sliceUtf16Safe(
        redactQaGatewayDebugText(errorMessage),
        0,
        QA_PACKAGE_AUTH_FAILURE_MAX_CHARS,
      );
      // oxlint-disable-next-line preserve-caught-error -- Candidate CLI errors can contain the submitted API key; only the redacted message crosses this boundary.
      throw new Error(`installed package mock auth bootstrap failed for ${provider}: ${details}`);
    }
  }
}

export async function startQaGatewayChild(params: {
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
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  enabledPluginIds?: string[];
  allowUnhealthyStartup?: boolean;
  forwardHostHome?: boolean;
  mockAuthAgentIds?: readonly string[];
  onListening?: (context: QaGatewayChildListeningContext) => Promise<void> | void;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
  runtimeEnvPatch?: NodeJS.ProcessEnv;
}) {
  // Verified launchers may require every runtime artifact to stay inside their
  // prepared root; carry that root forward instead of rediscovering host temp policy.
  const tempParentDir = params.command?.tempParentDir ?? resolvePreferredOpenClawTmpDir();
  const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";
  const gatewayLogStreams: Array<["stdout" | "stderr", WriteStream]> = [];
  let child: ReturnType<typeof spawn> | null = null;
  let childIdentity: QaGatewayVerifiedProcessIdentity | null = null;
  let processBoundaryController: Awaited<
    ReturnType<typeof createQaGatewayProcessBoundaryController>
  > | null = null;
  let rpcClient: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | null = null;
  let gatewayPortReservation: Awaited<ReturnType<typeof reserveQaGatewayPort>> | null = null;
  let stagedBundledPluginsRoot: string | null = null;
  const tempRoot = await fs.mkdtemp(path.join(tempParentDir, "openclaw-qa-suite-"));
  // The startup owner must release its temp root even when launcher or staging
  // setup fails before a child process or log streams have been created.
  try {
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
    gatewayLogStreams.push(["stdout", stdoutLog]);
    const stderrLog = createWriteStream(stderrLogPath, { flags: "a" });
    gatewayLogStreams.push(["stderr", stderrLog]);

    const logs = () => redactQaGatewayDebugText(output.text());
    let gatewayPort = 0;
    let baseUrl = "";
    let wsUrl = "";
    let cfg!: OpenClawConfig;
    let getChildFailure: (() => QaChildFailure | null) | null = null;
    let env: NodeJS.ProcessEnv | null = null;
    let packagedMockAuthStaged = false;
    let migrationConvergenceRestartUsed = false;
    let reuseStartupLaunchState = false;

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
    processBoundaryController = gatewayCommand?.processBoundary
      ? await createQaGatewayProcessBoundaryController({
          config: gatewayCommand.processBoundary,
          launcherPath: nodeExecPath,
          tempRoot,
        })
      : null;
    const spawnGatewayProcess = async (runtimeEnv: NodeJS.ProcessEnv) => {
      const gatewayArgs = buildGatewayArgs();
      const preparedBoundary = processBoundaryController
        ? await processBoundaryController.prepare({
            args: gatewayArgs,
            cwd: gatewayCwd,
            env: runtimeEnv,
          })
        : null;
      const spawnedChild = spawn(nodeExecPath, gatewayArgs, {
        cwd: gatewayCwd,
        env: preparedBoundary?.env ?? runtimeEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawnedChild.stdout.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        output.push("stdout", buffer);
        stdoutLog.write(buffer);
      });
      spawnedChild.stderr.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        output.push("stderr", buffer);
        stderrLog.write(buffer);
      });
      const getSpawnedChildFailure = monitorQaGatewayChildFailure(spawnedChild, output);
      let identity: QaGatewayVerifiedProcessIdentity | null = null;
      try {
        identity =
          preparedBoundary && processBoundaryController
            ? await processBoundaryController.accept({
                child: spawnedChild,
                prepared: preparedBoundary,
              })
            : null;
        if (identity && processBoundaryController) {
          await processBoundaryController.signal(identity, "SIGCONT");
        }
        return {
          child: spawnedChild,
          getChildFailure: getSpawnedChildFailure,
          identity,
        };
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (identity) {
          try {
            await stopQaGatewayChildWithBoundary({
              child: spawnedChild,
              controller: processBoundaryController,
              identity,
              opts: {
                gracefulTimeoutMs: 1_500,
              },
            });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        } else {
          if (preparedBoundary && processBoundaryController) {
            try {
              await processBoundaryController.abort({
                child: spawnedChild,
                prepared: preparedBoundary,
              });
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }
          try {
            await stopQaGatewayChildProcessTree(spawnedChild, {
              gracefulTimeoutMs: 1_500,
            });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        const boundaryFailure = preparedBoundary
          ? formatQaGatewayProcessBoundaryStartupFailure(error, logs())
          : null;
        if (cleanupErrors.length > 0) {
          const cleanupFailure = new AggregateError(
            [error, ...cleanupErrors],
            boundaryFailure
              ? `qa gateway failed before verified process cleanup completed: ${boundaryFailure}`
              : "qa gateway failed before verified process cleanup completed",
            { cause: error },
          );
          throw cleanupFailure;
        }
        if (boundaryFailure) {
          throw new Error(boundaryFailure, { cause: error });
        }
        throw error;
      }
    };
    for (let attempt = 1; attempt <= QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS; attempt += 1) {
      if (!reuseStartupLaunchState) {
        gatewayPortReservation = await reserveQaGatewayPort(net.createServer());
        gatewayPort = gatewayPortReservation.port;
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
            stagedBundledPluginsRoot = resolveQaStagedBundledPluginsRoot({
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
            stagedBundledPluginsRoot,
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
      }
      if (!env) {
        throw new Error("qa gateway runtime env not initialized");
      }
      reuseStartupLaunchState = false;

      const attemptLogMark = output.mark();
      // Hold the selected port through plugin/config staging so parallel QA workers
      // cannot satisfy readiness against one another. Release only for the child bind.
      await gatewayPortReservation?.release();
      gatewayPortReservation = null;
      const spawnedAttempt = await spawnGatewayProcess(env);
      const attemptChild = spawnedAttempt.child;
      child = attemptChild;
      childIdentity = spawnedAttempt.identity;
      const getAttemptChildFailure = spawnedAttempt.getChildFailure;

      try {
        await waitForGatewayListening({
          baseUrl,
          logs,
          child: attemptChild,
          getChildFailure: getAttemptChildFailure,
          timeoutMs: 120_000,
        });
        await params.onListening?.({
          attempt,
          baseUrl,
          wsUrl,
          token: gatewayToken,
          configPath,
          runtimeEnv: env,
        });
        if (!params.allowUnhealthyStartup) {
          await waitForGatewayReady({
            baseUrl,
            logs,
            child: attemptChild,
            getChildFailure: getAttemptChildFailure,
            timeoutMs: 120_000,
          });
        }
        const attemptRpcClient = await startQaGatewayRpcClient({
          wsUrl,
          token: gatewayToken,
          logs,
        });
        try {
          let rpcReady = false;
          let lastRpcStartupError: unknown = null;
          for (let rpcAttempt = 1; rpcAttempt <= 4; rpcAttempt += 1) {
            try {
              await attemptRpcClient.request(
                "config.get",
                {},
                {
                  timeoutMs: QA_GATEWAY_CHILD_RPC_STARTUP_TIMEOUT_MS,
                },
              );
              rpcReady = true;
              break;
            } catch (error) {
              lastRpcStartupError = error;
              if (rpcAttempt >= 4 || !isRetryableRpcStartupError(error)) {
                throw error;
              }
              await sleep(500 * rpcAttempt);
              await waitForGatewayReady({
                baseUrl,
                logs,
                child: attemptChild,
                getChildFailure: getAttemptChildFailure,
                timeoutMs: QA_GATEWAY_CHILD_RPC_RETRY_HEALTH_TIMEOUT_MS,
              });
            }
          }
          if (!rpcReady) {
            throw toErrorObject(
              lastRpcStartupError ?? new Error("qa gateway rpc client failed to start"),
              "Non-Error thrown",
            );
          }
          throwQaGatewayChildFailure(getAttemptChildFailure, logs);
        } catch (error) {
          await attemptRpcClient.stop().catch(() => {});
          throw error;
        }
        rpcClient = attemptRpcClient;
        getChildFailure = getAttemptChildFailure;
        if (childIdentity && processBoundaryController) {
          await processBoundaryController.markReady(childIdentity);
        }
        break;
      } catch (error) {
        const details = formatErrorMessage(error);
        const attemptLogs = redactQaGatewayDebugText(output.readSince(attemptLogMark));
        const startupRetry = resolveQaGatewayStartupRetry({
          attempt,
          details: attemptLogs.trim() ? attemptLogs : details,
          migrationConvergenceRestartUsed,
        });
        const retryableRpcStartup =
          attempt < QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS &&
          !startupRetry &&
          isRetryableRpcStartupError(error);
        if (rpcClient) {
          await rpcClient.stop().catch(() => {});
          rpcClient = null;
        }
        await stopQaGatewayChildWithBoundary({
          child: attemptChild,
          controller: processBoundaryController,
          identity: childIdentity,
          opts: {
            gracefulTimeoutMs: 1_500,
            forceTimeoutMs: 1_500,
          },
        });
        child = null;
        childIdentity = null;
        if (!startupRetry && !retryableRpcStartup) {
          throw error;
        }
        migrationConvergenceRestartUsed =
          startupRetry?.migrationConvergenceRestartUsed ?? migrationConvergenceRestartUsed;
        reuseStartupLaunchState = startupRetry?.reuseLaunchState ?? false;
        const retryMessage =
          startupRetry?.kind === "migration-convergence-restart"
            ? `[qa-lab] gateway child startup attempt ${attempt}/${QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS} completed plugin migration convergence; restarting once with the same state, config, and port ${gatewayPort}\n`
            : `[qa-lab] gateway child startup attempt ${attempt}/${QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS} hit a transient startup race on port ${gatewayPort}; retrying with a new port\n`;
        const retryBuffer = Buffer.from(retryMessage);
        output.push("internal", retryBuffer);
        stdoutLog.write(retryBuffer);
      }
    }

    if (!child || !cfg || !baseUrl || !wsUrl || !rpcClient || !getChildFailure || !env) {
      throw new Error("qa gateway child failed to start");
    }
    if (processBoundaryController && !childIdentity) {
      throw new Error("qa gateway child started without verified process identity");
    }
    let activeChild = child;
    let activeIdentity = childIdentity;
    let activeRpcClient = rpcClient;
    let activeGetChildFailure = getChildFailure;
    const runningEnv = env;
    const throwActiveChildFailure = () => throwQaGatewayChildFailure(activeGetChildFailure, logs);

    const spawnReplacementGatewayChildOnce = async () => {
      const spawnedReplacement = await spawnGatewayProcess(runningEnv);
      const nextChild = spawnedReplacement.child;
      const nextIdentity = spawnedReplacement.identity;
      const getNextChildFailure = spawnedReplacement.getChildFailure;

      try {
        await waitForGatewayReady({
          baseUrl,
          logs,
          child: nextChild,
          getChildFailure: getNextChildFailure,
          timeoutMs: 120_000,
        });
        const nextRpcClient = await startQaGatewayRpcClient({
          wsUrl,
          token: gatewayToken,
          logs,
        });
        try {
          let rpcReady = false;
          let lastRpcStartupError: unknown = null;
          for (let rpcAttempt = 1; rpcAttempt <= 4; rpcAttempt += 1) {
            try {
              await nextRpcClient.request(
                "config.get",
                {},
                {
                  timeoutMs: QA_GATEWAY_CHILD_RPC_STARTUP_TIMEOUT_MS,
                },
              );
              rpcReady = true;
              break;
            } catch (error) {
              lastRpcStartupError = error;
              if (rpcAttempt >= 4 || !isRetryableRpcStartupError(error)) {
                throw error;
              }
              await sleep(500 * rpcAttempt);
              await waitForGatewayReady({
                baseUrl,
                logs,
                child: nextChild,
                getChildFailure: getNextChildFailure,
                timeoutMs: 15_000,
              });
            }
          }
          if (!rpcReady) {
            throw toErrorObject(
              lastRpcStartupError ?? new Error("qa gateway rpc client failed to start"),
              "Non-Error thrown",
            );
          }
          throwQaGatewayChildFailure(getNextChildFailure, logs);
        } catch (error) {
          await nextRpcClient.stop().catch(() => {});
          throw error;
        }
        if (nextIdentity && processBoundaryController) {
          await processBoundaryController.markReady(nextIdentity);
        }
        return {
          child: nextChild,
          identity: nextIdentity,
          rpcClient: nextRpcClient,
          getChildFailure: getNextChildFailure,
        };
      } catch (error) {
        await stopQaGatewayChildWithBoundary({
          child: nextChild,
          controller: processBoundaryController,
          identity: nextIdentity,
          opts: {
            gracefulTimeoutMs: 1_500,
            forceTimeoutMs: 1_500,
          },
        });
        throw error;
      }
    };

    const spawnReplacementGatewayChild = async () => {
      const replacementLogMark = output.mark();
      try {
        return await spawnReplacementGatewayChildOnce();
      } catch (error) {
        const details = [
          redactQaGatewayDebugText(output.readSince(replacementLogMark)),
          formatErrorMessage(error),
        ].join("\n");
        const retry = resolveQaGatewayStartupRetry({
          attempt: 1,
          details,
          migrationConvergenceRestartUsed: false,
        });
        if (retry?.kind !== "migration-convergence-restart") {
          throw error;
        }
        const retryBuffer = Buffer.from(
          "[qa-lab] replacement gateway completed plugin migration convergence; restarting once with the same state, config, and port\n",
        );
        output.push("internal", retryBuffer);
        stdoutLog.write(retryBuffer);
        return await spawnReplacementGatewayChildOnce();
      }
    };

    const signalActiveProcess = async (signal: NodeJS.Signals) => {
      if (activeIdentity && processBoundaryController) {
        if (signal !== "SIGUSR1" && signal !== "SIGUSR2") {
          throw new Error(`unsupported verified gateway signal: ${signal}`);
        }
        await processBoundaryController.signal(activeIdentity, signal);
        return;
      }
      if (!activeChild.pid) {
        throw new Error("qa gateway child has no pid");
      }
      process.kill(activeChild.pid, signal);
    };

    return {
      cfg,
      baseUrl,
      wsUrl,
      get pid() {
        return activeIdentity?.pid ?? activeChild.pid ?? null;
      },
      getProcessCpuMs: () => readProcessTreeCpuMs(activeIdentity?.pid ?? activeChild.pid ?? null),
      getProcessRssBytes: () =>
        readProcessTreeRssBytes(activeIdentity?.pid ?? activeChild.pid ?? null),
      token: gatewayToken,
      workspaceDir,
      tempRoot,
      configPath,
      runtimeEnv: runningEnv,
      logs,
      runCli(args: readonly string[]) {
        throwActiveChildFailure();
        return runQaGatewayCliCommand({
          executablePath: nodeExecPath,
          argsPrefix: cliArgsPrefix,
          args,
          cwd: gatewayCwd,
          env: runningEnv,
        });
      },
      async signalProcess(signal: NodeJS.Signals) {
        throwActiveChildFailure();
        await signalActiveProcess(signal);
      },
      async restart(signal: NodeJS.Signals = "SIGUSR1") {
        throwActiveChildFailure();
        const restartLogMark = output.mark();
        await signalActiveProcess(signal);
        if (signal === "SIGUSR1") {
          await waitForQaGatewayRestartBoundary({
            readLogsSince: (mark) => redactQaGatewayDebugText(output.readSince(mark)),
            mark: restartLogMark,
          });
          await waitForGatewayReady({
            baseUrl,
            logs,
            child: activeChild,
            getChildFailure: activeGetChildFailure,
            timeoutMs: 120_000,
          });
        }
      },
      async restartAfterStateMutation(
        mutateState: (context: QaGatewayChildStateMutationContext) => Promise<void>,
      ) {
        throwActiveChildFailure();
        await activeRpcClient.stop().catch(() => {});
        await stopQaGatewayChildWithBoundary({
          child: activeChild,
          controller: processBoundaryController,
          identity: activeIdentity,
        });
        await mutateState({
          configPath,
          runtimeEnv: runningEnv,
          stateDir,
          tempRoot,
        });
        const restarted = await spawnReplacementGatewayChild();
        activeChild = restarted.child;
        activeIdentity = restarted.identity;
        activeRpcClient = restarted.rpcClient;
        activeGetChildFailure = restarted.getChildFailure;
        child = activeChild;
        childIdentity = activeIdentity;
        rpcClient = activeRpcClient;
      },
      async call(
        method: string,
        rpcParams?: unknown,
        opts?: { deadlineMs?: number; expectFinal?: boolean; timeoutMs?: number },
      ) {
        const timeoutMs = opts?.timeoutMs ?? 20_000;
        return await callQaGatewayWithRetry({
          deadlineMs: opts?.deadlineMs,
          logs,
          request: async (requestOptions) =>
            await activeRpcClient.request(method, rpcParams, {
              ...opts,
              ...requestOptions,
            }),
          throwChildFailure: throwActiveChildFailure,
          timeoutMs,
          waitForReady: async (readinessTimeoutMs) =>
            await waitForGatewayReady({
              baseUrl,
              logs,
              child: activeChild,
              getChildFailure: activeGetChildFailure,
              timeoutMs: readinessTimeoutMs,
            }),
        });
      },
      async stop(opts?: { keepTemp?: boolean; preserveToDir?: string }) {
        await activeRpcClient.stop().catch(() => {});
        const cleanupErrors: unknown[] = [];
        let processStopped = true;
        let debugArtifactsPreserved = true;
        try {
          await stopQaGatewayChildWithBoundary({
            child: activeChild,
            controller: processBoundaryController,
            identity: activeIdentity,
          });
        } catch (error) {
          processStopped = false;
          cleanupErrors.push(error);
        }
        for (const [label, stream] of gatewayLogStreams) {
          try {
            await closeQaGatewayLogStream(stream, label);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (opts?.preserveToDir && !(opts?.keepTemp ?? keepTemp)) {
          try {
            await preserveQaGatewayDebugArtifacts({
              preserveToDir: opts.preserveToDir,
              stdoutLogPath,
              stderrLogPath,
              tempRoot,
              repoRoot: params.repoRoot,
            });
          } catch (error) {
            debugArtifactsPreserved = false;
            cleanupErrors.push(
              new Error(appendQaGatewayTempRoot(formatErrorMessage(error), tempRoot), {
                cause: error,
              }),
            );
          }
        }
        if (processStopped && debugArtifactsPreserved && !(opts?.keepTemp ?? keepTemp)) {
          try {
            await cleanupQaGatewayTempRoots({
              tempRoot,
              stagedBundledPluginsRoot,
            });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          throwActiveChildFailure();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0];
        }
        if (cleanupErrors.length > 1) {
          throw new AggregateError(cleanupErrors, "qa gateway child cleanup failed");
        }
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (gatewayPortReservation) {
      try {
        await gatewayPortReservation.release();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    await rpcClient?.stop().catch(() => {});
    let processStopped = child === null;
    if (child) {
      try {
        await stopQaGatewayChildWithBoundary({
          child,
          controller: processBoundaryController,
          identity: childIdentity,
          opts: {
            gracefulTimeoutMs: 1_500,
            forceTimeoutMs: 1_500,
          },
        });
        processStopped = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    for (const [label, stream] of gatewayLogStreams) {
      try {
        await closeQaGatewayLogStream(stream, label);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (processStopped && !keepTemp) {
      try {
        await cleanupQaGatewayTempRoots({
          tempRoot,
          stagedBundledPluginsRoot,
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const message =
      keepTemp || !processStopped
        ? appendQaGatewayTempRoot(formatErrorMessage(error), tempRoot)
        : formatErrorMessage(error);
    return throwQaGatewayStartupError({ error, message, cleanupErrors });
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
