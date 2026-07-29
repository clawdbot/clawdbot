// QA runner runtime helpers expose plugin QA scenarios through the CLI command surface.
import type { Command } from "commander";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  loadBundledPluginManifestRegistry,
  loadPluginManifestRegistry,
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
  requireGroupMention?: true;
  senderAllowlist?: readonly string[];
  topLevelReplies?: true;
};

type QaRunnerAdapterOptions = {
  explicitScenarioSelection?: boolean;
  repoRoot?: string;
  scenarioIds?: readonly string[];
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
  transportPolicy?: QaRunnerTransportPolicy;
};

type QaRunnerMessageRecorder = {
  addInboundMessage: (input: QaBusInboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  addOutboundMessage: (input: QaBusOutboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  editMessage: (input: QaBusEditMessageInput) => QaBusMessage | Promise<QaBusMessage>;
};

type QaRunnerTransportFlowPreparationInput = {
  config: Record<string, unknown>;
  gateway: {
    baseUrl: string;
    tempRoot: string;
    workspaceDir: string;
    runtimeEnv: NodeJS.ProcessEnv;
    call: (
      method: string,
      params?: unknown,
      options?: { expectFinal?: boolean; timeoutMs?: number },
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
};

type QaRunnerTransportFactory = {
  id: string;
  /** Each create() call owns isolated runtime state and may run concurrently. */
  isolatesInstances?: boolean;
  matches: (context: { channelId: string; driver: string }) => boolean;
  create: (context: {
    adapterOptions?: QaRunnerAdapterOptions;
    channelId: string;
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

type QaRunnerRuntimeSurface = {
  qaRunnerCliRegistrations?: readonly QaRunnerCliRegistration[];
};

type QaRuntimeSurface = {
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
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

function listDeclaredQaRunnerPlugins(
  env: NodeJS.ProcessEnv | undefined = resolvePrivateQaBundledPluginsEnv(),
): Array<
  PluginManifestRecord & {
    qaRunners: NonNullable<PluginManifestRecord["qaRunners"]>;
  }
> {
  // Private QA is a source-checkout harness. Its command tree must be derived
  // from repo-owned manifests before Commander pre-action hooks can run.
  const registry = env ? loadBundledPluginManifestRegistry({ env }) : loadPluginManifestRegistry();
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
  surface: QaRunnerRuntimeSurface,
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

function loadQaRunnerRuntimeSurface(
  plugin: PluginManifestRecord,
  env?: NodeJS.ProcessEnv,
): QaRunnerRuntimeSurface | null {
  if (plugin.origin === "bundled") {
    return loadBundledPluginPublicSurfaceModuleSync<QaRunnerRuntimeSurface>({
      dirName: plugin.id,
      artifactBasename: "runtime-api.js",
      ...(env ? { env } : {}),
    });
  }
  return tryLoadActivatedBundledPluginPublicSurfaceModuleSync<QaRunnerRuntimeSurface>({
    dirName: plugin.id,
    artifactBasename: "runtime-api.js",
    ...(env ? { env } : {}),
  });
}

/** List QA runner CLI contributions declared by manifests and backed by runtime registrations. */
export function listQaRunnerCliContributions(): readonly QaRunnerCliContribution[] {
  const env = resolvePrivateQaBundledPluginsEnv();
  const contributions = new Map<string, QaRunnerCliContribution>();

  for (const plugin of listDeclaredQaRunnerPlugins(env)) {
    const runtimeSurface = loadQaRunnerRuntimeSurface(plugin, env);
    const runtimeRegistrationByCommandName = runtimeSurface
      ? indexRuntimeRegistrations(plugin.id, runtimeSurface)
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
      if (!runtimeSurface) {
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
          `QA runner plugin "${plugin.id}" declared "${runner.commandName}" in openclaw.plugin.json but did not export a matching CLI registration`,
        );
      }
      const adapterFactory = registration.adapterFactory;
      if (
        adapterFactory &&
        (adapterFactory.id !== runner.commandName ||
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
          `QA runner plugin "${plugin.id}" exported "${commandName}" from runtime-api.js but did not declare it in openclaw.plugin.json`,
        );
      }
    }
  }

  return [...contributions.values()];
}
