// QA runner runtime helpers expose plugin QA scenarios through the CLI command surface.
import type { Command } from "commander";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  loadBundledPluginManifestRegistry,
  loadPluginManifestRegistryCore,
} from "../plugins/manifest-registry.js";
import type { OpenClawConfig } from "./config-contracts.js";
import {
  loadBundledPluginPublicSurfaceModuleSync,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";
import { resolvePrivateQaBundledPluginsEnv } from "./private-qa-bundled-env.js";
import type {
  QaBusEditMessageInput,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
} from "./qa-channel-protocol.js";

type QaRunnerTransportPolicy = {
  directMessageOnly?: true;
  requireGroupMention?: true;
  senderAllowlist?: readonly string[];
  topLevelReplies?: true;
};

type QaRunnerAdapterOptions = {
  explicitScenarioSelection?: boolean;
  repoRoot?: string;
  scenarioIds?: readonly string[];
  sutAccountId?: string;
  credentialFile?: string;
  credentialSource?: string;
  credentialRole?: string;
  transportPolicy?: QaRunnerTransportPolicy;
};

type QaRunnerMessageRecorder = {
  addInboundMessage: (input: QaBusInboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  addOutboundMessage: (input: QaBusOutboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  editMessage: (input: QaBusEditMessageInput) => QaBusMessage | Promise<QaBusMessage>;
};

type QaRunnerCredentialLease<TPayload> = {
  credentialId?: string;
  heartbeat(): Promise<void>;
  heartbeatIntervalMs: number;
  kind: string;
  leaseToken?: string;
  leaseTtlMs: number;
  ownerId?: string;
  payload: TPayload;
  release(): Promise<void>;
  role?: "ci" | "maintainer";
  source: "convex" | "env";
};

type QaRunnerCredentialLeaseOptions<TPayload> = {
  kind: string;
  parsePayload: (payload: unknown) => TPayload;
  resolveEnvPayload: () => TPayload;
  role?: string;
  source?: string;
};

type QaRunnerCredentialHeartbeat = {
  getFailure(): Error | null;
  stop(): Promise<void>;
  throwIfFailed(): void;
};

type QaRunnerCredentialHost = {
  acquire<TPayload>(
    options: QaRunnerCredentialLeaseOptions<TPayload>,
  ): Promise<QaRunnerCredentialLease<TPayload>>;
  startHeartbeat(
    lease: Pick<
      QaRunnerCredentialLease<unknown>,
      "heartbeat" | "heartbeatIntervalMs" | "kind" | "source"
    >,
  ): QaRunnerCredentialHeartbeat;
};

type QaRunnerTransportFlowPreparationInput = {
  signal?: AbortSignal;
  config: Record<string, unknown>;
  scenarioId: string;
  scenarioTitle: string;
  gateway: {
    baseUrl: string;
    tempRoot: string;
    workspaceDir: string;
    runtimeEnv: NodeJS.ProcessEnv;
    call: (
      method: string,
      params?: unknown,
      options?: { deadlineMs?: number; expectFinal?: boolean; timeoutMs?: number },
    ) => Promise<unknown>;
    restartAfterStateMutation?: (
      mutateState: (context: {
        configPath: string;
        runtimeEnv: NodeJS.ProcessEnv;
        stateDir: string;
        tempRoot: string;
      }) => Promise<void>,
    ) => Promise<void>;
    stop?: (options?: { preserveToDir?: string }) => Promise<void>;
  };
  waitForConfigRestartSettle: (options?: {
    restartDelayMs?: number;
    timeoutMs?: number;
  }) => Promise<void>;
  outputDir: string;
  primaryModel?: string;
  timeoutMs: number;
};

type QaRunnerTransportAdapterDefinition = {
  id: string;
  label: string;
  accountId: string;
  requiredPluginIds: readonly string[];
  supportedActions: readonly ("delete" | "edit" | "react" | "thread-create")[];
  assertTransportHealthy?: () => void;
  describeTransportState?: () => string;
  resetTransport?: () => void | Promise<void>;
  sendInbound: (input: QaBusInboundMessageInput) => Promise<QaBusMessage>;
  sendNativeCommand?: (
    input: Omit<QaBusInboundMessageInput, "nativeCommand" | "text"> & { command: string },
  ) => Promise<void>;
  waitForOutboundSequence?: (input: {
    conversationId?: string;
    finalSettleMs?: number;
    finalTextIncludes: string;
    minimumPreviewEvents?: number;
    sinceCursor?: number;
    threadId?: string;
    timeoutMs?: number;
  }) => Promise<{
    events: Array<{ cursor: number; kind: "sent" | "edited" | "deleted"; message: QaBusMessage }>;
    final: QaBusMessage;
  }>;
  createGatewayConfig: (params: {
    baseUrl: string;
  }) => Pick<OpenClawConfig, "channels" | "messages">;
  waitReady: (params: {
    gateway: {
      call: (
        method: string,
        params?: unknown,
        options?: { timeoutMs?: number },
      ) => Promise<unknown>;
    };
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<void>;
  buildAgentDelivery: (params: { target: string }) => {
    channel: string;
    to?: string;
    replyChannel: string;
    replyTo: string;
  };
  createRuntimeEnvPatch?: () => NodeJS.ProcessEnv;
  prepareFlow?: (
    input: QaRunnerTransportFlowPreparationInput,
  ) => Promise<Record<string, unknown> | void>;
  handleAction: (params: {
    action: "delete" | "edit" | "react" | "thread-create";
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<unknown>;
  createReportNotes: (params: {
    providerMode: "mock-openai" | "aimock" | "live-frontier";
    primaryModel: string;
    alternateModel: string;
    fastMode: boolean;
    concurrency: number;
    isolatedWorkers?: boolean;
  }) => string[];
  cleanup?: () => Promise<void>;
  cleanupAfterGatewayStop?: () => Promise<void>;
};

type QaRunnerTransportFactory = {
  id: string;
  /** Enables module-backed scenarios; every created adapter must implement `prepareFlow`. */
  supportsModuleFlows?: true;
  /** Each create() call owns isolated runtime state and may run concurrently. */
  isolatesInstances?: boolean;
  matches: (context: { channelId: string; driver: string }) => boolean;
  create: (context: {
    adapterOptions?: QaRunnerAdapterOptions;
    channelId: string;
    credentials: QaRunnerCredentialHost;
    driver: string;
    messages: QaRunnerMessageRecorder;
    outputDir: string;
  }) => Promise<QaRunnerTransportAdapterDefinition>;
};

/** CLI registration and optional transport adapter factory exported by a QA runner plugin. */
export type QaRunnerCliRegistration = {
  commandName: string;
  adapterFactory?: QaRunnerTransportFactory;
  register(qa: Command): void;
};

/** Normalized options passed from live-transport QA CLIs into lane runners. */
export type LiveTransportQaCommandOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: string;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  allowFailures?: boolean;
  failFast?: boolean;
  profile?: string;
  scenarioIds?: string[];
  listScenarios?: boolean;
  sutAccountId?: string;
  credentialFile?: string;
  credentialSource?: string;
  credentialRole?: string;
};

export type LiveTransportQaSuiteCommandOptions = {
  channelId: string;
  credentialMode?: "env-only" | "shared-lease";
  defaultProviderMode: string;
  envCredentialReason?: string;
  laneLabel?: string;
  options: LiveTransportQaCommandOptions;
  selectScenarioIds: (params: {
    profile?: string;
    primaryModel: string;
    providerMode: string;
    scenarioIds?: readonly string[];
  }) => string[];
};

type LiveTransportQaCommanderOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: string;
  model?: string;
  altModel?: string;
  scenario?: string[];
  listScenarios?: boolean;
  fast?: boolean;
  allowFailures?: boolean;
  failFast?: boolean;
  profile?: string;
  sutAccount?: string;
  credentialFile?: string;
  credentialSource?: string;
  credentialRole?: string;
};

/** Commander registration hook for one live-transport QA subcommand. */
export type LiveTransportQaCliRegistration = QaRunnerCliRegistration;

/** Help text customizations for live credential source and role flags. */
export type LiveTransportQaCredentialCliOptions = {
  sourceDescription?: string;
  roleDescription?: string;
};

/** Declarative command metadata and runner used to install a live-transport QA CLI. */
export type LiveTransportQaCliRegistrationOptions = {
  commandName: string;
  credentialFileHelp?: string;
  credentialOptions?: LiveTransportQaCredentialCliOptions;
  defaultProviderMode: string;
  description: string;
  providerModeHelp: string;
  listScenariosHelp?: string;
  outputDirHelp: string;
  profileHelp?: string;
  failFastHelp?: string;
  allowFailuresHelp?: string;
  scenarioHelp: string;
  sutAccountHelp: string;
  adapterFactory?: QaRunnerCliRegistration["adapterFactory"];
  run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
};

/** Memoize a lazy CLI runtime import so repeated command paths share one loaded module. */
export function createLazyCliRuntimeLoader<T>(load: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  return async () => {
    promise ??= load();
    return await promise;
  };
}

function collectLiveTransportQaStringOption(value: string, previous: string[]) {
  const trimmed = value.trim();
  return trimmed ? [...previous, trimmed] : previous;
}

function mapLiveTransportQaCommanderOptions(
  opts: LiveTransportQaCommanderOptions,
): LiveTransportQaCommandOptions {
  return {
    repoRoot: opts.repoRoot,
    outputDir: opts.outputDir,
    providerMode: opts.providerMode,
    primaryModel: opts.model,
    alternateModel: opts.altModel,
    fastMode: opts.fast,
    allowFailures: opts.allowFailures,
    failFast: opts.failFast,
    profile: opts.profile,
    scenarioIds: opts.scenario,
    listScenarios: opts.listScenarios,
    sutAccountId: opts.sutAccount,
    credentialFile: opts.credentialFile,
    credentialSource: opts.credentialSource,
    credentialRole: opts.credentialRole,
  };
}

function registerLiveTransportQaCli(
  params: LiveTransportQaCliRegistrationOptions & {
    qa: Command;
    run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
  },
) {
  const command = params.qa
    .command(params.commandName)
    .description(params.description)
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", params.outputDirHelp)
    .option("--provider-mode <mode>", params.providerModeHelp, params.defaultProviderMode)
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option("--scenario <id>", params.scenarioHelp, collectLiveTransportQaStringOption, [])
    .option("--fast", "Enable provider fast mode where supported");

  if (params.allowFailuresHelp) {
    command.option("--allow-failures", params.allowFailuresHelp, false);
  }

  command.option("--sut-account <id>", params.sutAccountHelp, "sut");

  if (params.credentialFileHelp) {
    command.option("--credential-file <path>", params.credentialFileHelp);
  }

  if (params.listScenariosHelp) {
    command.option("--list-scenarios", params.listScenariosHelp, false);
  }

  if (params.profileHelp) {
    command.option("--profile <profile>", params.profileHelp);
  }

  if (params.failFastHelp) {
    command.option("--fail-fast", params.failFastHelp, false);
  }

  if (params.credentialOptions) {
    command.option(
      "--credential-source <source>",
      params.credentialOptions.sourceDescription ??
        "Credential source for live lanes: env or convex (default: env)",
    );
    if (params.credentialOptions.roleDescription) {
      command.option("--credential-role <role>", params.credentialOptions.roleDescription);
    }
  }

  command.action(async (opts: LiveTransportQaCommanderOptions) => {
    await params.run(mapLiveTransportQaCommanderOptions(opts));
  });
}

/** Build a Commander registration object for one live-transport QA command. */
export function createLiveTransportQaCliRegistration(
  params: LiveTransportQaCliRegistrationOptions,
): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    adapterFactory: params.adapterFactory,
    register(qa: Command) {
      registerLiveTransportQaCli({
        ...params,
        qa,
      });
    },
  };
}

type QaRunnerSurface = {
  qaRunnerCliRegistrations?: readonly QaRunnerCliRegistration[];
};

const QA_RUNNER_API_ARTIFACT_BASENAME = "qa-runner-api.js";
const LEGACY_QA_RUNNER_API_ARTIFACT_BASENAME = "runtime-api.js";

type QaRuntimeSurface = {
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  createQaLiveLaneGateway: () => {
    start: (...args: unknown[]) => Promise<unknown>;
    stop: () => Promise<{
      process: "never-spawned" | "confirmed-stopped" | "unconfirmed";
      errors: unknown[];
    }>;
  };
  runLiveTransportQaSuiteCommand: (params: LiveTransportQaSuiteCommandOptions) => Promise<unknown>;
};

/** Resolved QA runner CLI contribution declared by plugin manifest metadata. */
export type QaRunnerCliContribution =
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "available";
      registration: QaRunnerCliRegistration;
    }
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "blocked";
    };

function isMissingQaRuntimeError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("qa-lab") &&
    (error.message.includes("runtime-api.js") ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

/** Load the private QA Lab runtime facade used by QA runner commands. */
export function loadQaRuntimeModule(): QaRuntimeSurface {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<QaRuntimeSurface>({
    dirName: ["qa", "lab"].join("-"),
    artifactBasename: ["runtime-api", "js"].join("."),
    ...(env ? { env } : {}),
  });
}

/** Load a bundled QA runner plugin test API facade by plugin id. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- QA runtime loader uses caller-supplied test API surface type.
export function loadQaRunnerBundledPluginTestApi<T extends object>(pluginId: string): T {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<T>({
    dirName: pluginId,
    artifactBasename: "test-api.js",
    ...(env ? { env } : {}),
  });
}

/** Returns whether the private QA Lab runtime facade is available in this build. */
export function isQaRuntimeAvailable(): boolean {
  try {
    loadQaRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}

/** Run a plugin-owned transport adapter through QA Lab's shared suite host. */
export async function runLiveTransportQaSuiteCommand(params: LiveTransportQaSuiteCommandOptions) {
  return await loadQaRuntimeModule().runLiveTransportQaSuiteCommand(params);
}

function listDeclaredQaRunnerPlugins(
  env: NodeJS.ProcessEnv | undefined = resolvePrivateQaBundledPluginsEnv(),
): Array<
  PluginManifestRecord & {
    qaRunners: NonNullable<PluginManifestRecord["qaRunners"]>;
  }
> {
  // Private QA is a source-checkout harness. Its command tree must be derived
  // from repo-owned manifests before Commander pre-action hooks can run.
  const registry = env
    ? loadBundledPluginManifestRegistry({ env })
    : loadPluginManifestRegistryCore();
  return registry.plugins
    .filter(
      (
        plugin,
      ): plugin is PluginManifestRecord & {
        qaRunners: NonNullable<PluginManifestRecord["qaRunners"]>;
      } => Array.isArray(plugin.qaRunners) && plugin.qaRunners.length > 0,
    )
    .toSorted((left, right) => {
      const idCompare = left.id.localeCompare(right.id);
      if (idCompare !== 0) {
        return idCompare;
      }
      return left.rootDir.localeCompare(right.rootDir);
    });
}

function indexRuntimeRegistrations(
  pluginId: string,
  surface: QaRunnerSurface,
): ReadonlyMap<string, QaRunnerCliRegistration> {
  const registrations = surface.qaRunnerCliRegistrations ?? [];
  const registrationByCommandName = new Map<string, QaRunnerCliRegistration>();
  for (const registration of registrations) {
    if (!registration?.commandName || typeof registration.register !== "function") {
      throw new Error(`QA runner plugin "${pluginId}" exported an invalid CLI registration`);
    }
    if (registrationByCommandName.has(registration.commandName)) {
      throw new Error(
        `QA runner plugin "${pluginId}" exported duplicate CLI registration "${registration.commandName}"`,
      );
    }
    registrationByCommandName.set(registration.commandName, registration);
  }
  return registrationByCommandName;
}

function loadQaRunnerSurface(
  plugin: PluginManifestRecord,
  env?: NodeJS.ProcessEnv,
): QaRunnerSurface | null {
  if (plugin.origin === "bundled") {
    return loadBundledPluginPublicSurfaceModuleSync<QaRunnerSurface>({
      dirName: plugin.id,
      artifactBasename: QA_RUNNER_API_ARTIFACT_BASENAME,
      ...(env ? { env } : {}),
    });
  }
  try {
    return tryLoadActivatedBundledPluginPublicSurfaceModuleSync<QaRunnerSurface>({
      dirName: plugin.id,
      artifactBasename: QA_RUNNER_API_ARTIFACT_BASENAME,
      ...(env ? { env } : {}),
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !==
        `Unable to resolve bundled plugin public surface ${plugin.id}/${QA_RUNNER_API_ARTIFACT_BASENAME}`
    ) {
      throw error;
    }
  }

  // qaRunners shipped through runtime-api.js in v2026.6.9. Keep activated
  // installed plugins working until the 2026-10-01 removal review.
  return tryLoadActivatedBundledPluginPublicSurfaceModuleSync<QaRunnerSurface>({
    dirName: plugin.id,
    artifactBasename: LEGACY_QA_RUNNER_API_ARTIFACT_BASENAME,
    ...(env ? { env } : {}),
  });
}

/** List QA runner CLI contributions declared by manifests and backed by runtime registrations. */
export function listQaRunnerCliContributions(): readonly QaRunnerCliContribution[] {
  const env = resolvePrivateQaBundledPluginsEnv();
  const contributions = new Map<string, QaRunnerCliContribution>();

  for (const plugin of listDeclaredQaRunnerPlugins(env)) {
    const runnerSurface = loadQaRunnerSurface(plugin, env);
    const runtimeRegistrationByCommandName = runnerSurface
      ? indexRuntimeRegistrations(plugin.id, runnerSurface)
      : null;
    const declaredCommandNames = new Set(plugin.qaRunners.map((runner) => runner.commandName));

    for (const runner of plugin.qaRunners) {
      const previous = contributions.get(runner.commandName);
      if (previous && previous.pluginId !== plugin.id) {
        throw new Error(
          `QA runner command "${runner.commandName}" declared by both "${previous.pluginId}" and "${plugin.id}"`,
        );
      }

      const registration = runtimeRegistrationByCommandName?.get(runner.commandName);
      if (!runnerSurface) {
        contributions.set(runner.commandName, {
          pluginId: plugin.id,
          commandName: runner.commandName,
          ...(runner.description ? { description: runner.description } : {}),
          status: "blocked",
        });
        continue;
      }
      if (!registration) {
        throw new Error(
          `QA runner plugin "${plugin.id}" declared "${runner.commandName}" in openclaw.plugin.json but did not export a matching CLI registration from its QA runner surface`,
        );
      }
      const adapterFactory = registration.adapterFactory;
      const supportsModuleFlows: unknown = adapterFactory
        ? Reflect.get(adapterFactory, "supportsModuleFlows")
        : undefined;
      if (
        adapterFactory &&
        (adapterFactory.id !== runner.commandName ||
          (supportsModuleFlows !== undefined && supportsModuleFlows !== true) ||
          (adapterFactory.isolatesInstances !== undefined &&
            typeof adapterFactory.isolatesInstances !== "boolean") ||
          typeof adapterFactory.matches !== "function" ||
          typeof adapterFactory.create !== "function")
      ) {
        throw new Error(
          `QA runner plugin "${plugin.id}" exported an invalid transport factory for "${runner.commandName}"`,
        );
      }
      contributions.set(runner.commandName, {
        pluginId: plugin.id,
        commandName: runner.commandName,
        ...(runner.description ? { description: runner.description } : {}),
        status: "available",
        registration,
      });
    }

    for (const commandName of runtimeRegistrationByCommandName?.keys() ?? []) {
      if (!declaredCommandNames.has(commandName)) {
        throw new Error(
          `QA runner plugin "${plugin.id}" exported "${commandName}" from its QA runner surface but did not declare it in openclaw.plugin.json`,
        );
      }
    }
  }

  return [...contributions.values()];
}
