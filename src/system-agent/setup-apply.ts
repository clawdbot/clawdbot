// Applies OpenClaw's conversational setup: config, workspace files, gateway.
import { isDeepStrictEqual } from "node:util";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  resolveConfigSnapshotHash,
  resolveGatewayPort,
  validateConfigObjectWithPlugins,
} from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  projectDefaultInferenceRoute,
  sameDefaultInferenceRoute,
  type DefaultInferenceRouteProjection,
} from "./inference-route.js";
import { requireValidSystemAgentSetupSnapshot } from "./setup-config-snapshot.js";

/**
 * The whole first-run setup as one approved operation: the user says "yes" in
 * the conversation and this applies model + workspace + quickstart gateway
 * defaults, seeds workspace bootstrap files, and (on the CLI surface) installs
 * and starts the gateway service. No interactive prompts may occur here —
 * everything uses quickstart defaults, so the conversation stays the only UI.
 */
export type SystemAgentSetupApplyParams = {
  workspace: string;
  model?: string;
  agentRuntimeId?: string;
  /** Pin the selected model to the exact credential that passed inference. */
  authProfileId?: string;
  /** Exact default-agent route whose inference passed the setup gate. */
  expectedInferenceRoute?: DefaultInferenceRouteProjection;
  /** Live-probe target; setup aborts if another process switches the default agent. */
  expectedAgentId?: string;
  /** Manual-auth target; setup aborts if the selected agent's credential directory moves. */
  expectedAgentDir?: string;
  /** Existing-model probe target; setup aborts if that model changes before persistence. */
  expectedModelRef?: string;
  /** Full config revision used by the live probe; null means the file was absent. */
  expectedConfigHash?: string | null;
  /** Provider-auth config produced in the isolated manual-key flow. */
  configPatch?: unknown;
  /** Success-gated final normalization against the config held by the write lock. */
  finalizeConfig?: (config: OpenClawConfig, sourceConfig: OpenClawConfig) => OpenClawConfig;
  /** Plugin whose enablement belongs to the successful setup transaction. */
  enablePluginId?: string;
  /** Refresh an installed plugin after its success-gated enablement commits. */
  refreshPluginRegistry?: boolean;
  /** Synchronous cross-store guard checked under the final config write lock. */
  assertCommitPreconditions?: () => void;
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
};

export type SystemAgentSetupApplyResult = {
  configPath: string;
  configHashBefore: string | null;
  configHashAfter: string | null;
  bootstrapPending: boolean;
  lines: string[];
};

type SystemAgentSetupApplyHooks = {
  /** Host-owned authority seam; called at every persistent setup boundary. */
  commit<T>(effect: () => Promise<T> | T): Promise<T>;
};

/** Prompter for quickstart-only flows: notes go to the log, prompts fail loud. */
export function createQuickstartNotePrompter(runtime: RuntimeEnv): WizardPrompter {
  const unexpected = (kind: string) => {
    throw new Error(`openclaw setup hit an interactive ${kind} prompt; quickstart must not ask`);
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => {
      runtime.log(title ? `${title}: ${message}` : message);
    },
    select: async (params) => {
      // Quickstart paths never select interactively; honor defaults if a
      // pre-answered prompt sneaks through, otherwise fail loud.
      if (params.initialValue !== undefined) {
        return params.initialValue;
      }
      return unexpected("select");
    },
    multiselect: async () => unexpected("multiselect"),
    text: async () => unexpected("text"),
    confirm: async (params) => params.initialValue ?? true,
    progress: (label) => {
      runtime.log(label);
      return {
        update: (message) => runtime.log(message),
        stop: (message) => {
          if (message) {
            runtime.log(message);
          }
        },
      };
    },
  };
}

function applySecurityAcknowledgement(config: OpenClawConfig): OpenClawConfig {
  if (config.wizard?.securityAcknowledgedAt) {
    return config;
  }
  // Conversational consent: the onboarding welcome shows the security note and
  // the user approved the plan, which is the acknowledgement we persist.
  return {
    ...config,
    wizard: { ...config.wizard, securityAcknowledgedAt: new Date().toISOString() },
  };
}

type SystemAgentModelSelectionParams = {
  config: OpenClawConfig;
  model: string;
  /** Write the model onto this configured agent instead of the default route. */
  targetAgentId?: string;
  agentRuntimeId?: string;
  /** Pin the selected model to the exact credential that passed inference. */
  authProfileId?: string;
};

type SystemAgentModelSelectionModules = {
  agentScope: typeof import("../agents/agent-scope.js");
  modelConfig: typeof import("../commands/models/shared.js");
  runtimePolicy: typeof import("../agents/model-runtime-policy.js");
};

function applySystemAgentModelSelectionWithModules(
  params: SystemAgentModelSelectionParams,
  modules: SystemAgentModelSelectionModules,
): OpenClawConfig {
  const { agentScope, modelConfig, runtimePolicy } = modules;
  const nextConfig = structuredClone(params.config);
  const targetAgentId = params.targetAgentId ? normalizeAgentId(params.targetAgentId) : undefined;
  const agentId = targetAgentId ?? agentScope.resolveDefaultAgentId(nextConfig);
  if (
    targetAgentId &&
    !nextConfig.agents?.list?.some((entry) => normalizeAgentId(entry.id) === targetAgentId)
  ) {
    throw new Error(`Could not resolve configured agent "${targetAgentId}".`);
  }
  // A targeted selection always lands on the agent entry; the default-route
  // selection only writes the agent when it already carries an explicit model.
  const writesAgent = Boolean(
    targetAgentId || agentScope.resolveAgentExplicitModelPrimary(nextConfig, agentId),
  );
  nextConfig.agents ??= {};
  nextConfig.agents.defaults ??= {};
  const target = modelConfig.resolveModelTarget({ raw: params.model, cfg: nextConfig });
  const key = modelConfig.upsertCanonicalModelConfigEntry({}, target);

  const configuredVisibleModels = nextConfig.agents.defaults.models;
  if (configuredVisibleModels && Object.keys(configuredVisibleModels).length > 0) {
    // An authored global visibility map is restrictive. Extend it for the
    // approved selection; never create one merely to carry runtime metadata.
    const defaultModels = { ...configuredVisibleModels };
    modelConfig.upsertCanonicalModelConfigEntry(defaultModels, target);
    nextConfig.agents.defaults.models = defaultModels;
  }

  let agent = nextConfig.agents.list?.find((entry) => normalizeAgentId(entry.id) === agentId);
  if (writesAgent) {
    if (!agent) {
      throw new Error(`Could not resolve configured default agent "${agentId}".`);
    }
    const agentModels = { ...agent.models };
    agent.models = agentModels;
    modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
  }

  if (params.agentRuntimeId) {
    if (!agent) {
      agent = { id: agentId, default: true };
      nextConfig.agents.list = [...(nextConfig.agents.list ?? []), agent];
    }
    const agentModels = { ...agent.models };
    const agentKey = modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
    agentModels[agentKey] = {
      ...agentModels[agentKey],
      agentRuntime: { id: params.agentRuntimeId },
    };
    agent.models = agentModels;
  } else {
    const clearRuntimePin = (
      models: Record<string, AgentModelEntryConfig>,
    ): Record<string, AgentModelEntryConfig> => {
      const nextModels = { ...models };
      const modelKey = modelConfig.upsertCanonicalModelConfigEntry(nextModels, target);
      const entry = { ...nextModels[modelKey] };
      delete entry.agentRuntime;
      nextModels[modelKey] = entry;
      return nextModels;
    };
    const defaultModels = nextConfig.agents.defaults.models;
    if (defaultModels && Object.keys(defaultModels).length > 0) {
      nextConfig.agents.defaults.models = clearRuntimePin(defaultModels);
    }
    if (agent?.models && Object.keys(agent.models).length > 0) {
      agent.models = clearRuntimePin(agent.models);
    }
  }
  const selectedModel = params.authProfileId ? `${key}@${params.authProfileId}` : key;
  agentScope.setAgentEffectiveModelPrimary(nextConfig, agentId, selectedModel, {
    forceAgent: Boolean(targetAgentId),
  });
  if (params.agentRuntimeId) {
    const effectiveRuntime = runtimePolicy.resolveModelRuntimePolicy({
      config: nextConfig,
      provider: target.provider,
      modelId: target.model,
      agentId,
    }).policy?.id;
    if (effectiveRuntime !== params.agentRuntimeId) {
      throw new Error(`Could not pin ${key} to the ${params.agentRuntimeId} runtime.`);
    }
  }
  return nextConfig;
}

export async function createSystemAgentModelSelectionUpdater(
  params: Omit<SystemAgentModelSelectionParams, "config">,
): Promise<(config: OpenClawConfig) => OpenClawConfig> {
  const [agentScope, modelConfig, runtimePolicy] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../commands/models/shared.js"),
    import("../agents/model-runtime-policy.js"),
  ]);
  const modules = { agentScope, modelConfig, runtimePolicy };
  return (config) => applySystemAgentModelSelectionWithModules({ ...params, config }, modules);
}

export async function applySystemAgentModelSelection(
  params: SystemAgentModelSelectionParams,
): Promise<OpenClawConfig> {
  const update = await createSystemAgentModelSelectionUpdater(params);
  return update(params.config);
}

export async function applySystemAgentSetup(
  params: SystemAgentSetupApplyParams,
  hooks?: SystemAgentSetupApplyHooks,
): Promise<SystemAgentSetupApplyResult> {
  const {
    workspace,
    model,
    agentRuntimeId,
    authProfileId,
    expectedAgentId,
    expectedAgentDir,
    expectedModelRef,
    expectedConfigHash,
    configPatch,
    finalizeConfig,
    enablePluginId,
    refreshPluginRegistry,
    assertCommitPreconditions,
    surface,
    runtime,
  } = params;
  const hasExpectedConfigHash = Object.hasOwn(params, "expectedConfigHash");
  const commit: SystemAgentSetupApplyHooks["commit"] = hooks
    ? async (effect) => await hooks.commit(effect)
    : async (effect) => await effect();
  const [
    { readSetupConfigFileSnapshot, resolveQuickstartGatewayDefaults },
    onboardHelpers,
    { applyLocalSetupWorkspaceConfig },
    { transformConfigWithPendingPluginInstalls },
  ] = await Promise.all([
    import("../wizard/setup.shared.js"),
    import("../commands/onboard-helpers.js"),
    import("../commands/onboard-config.js"),
    import("../plugins/install-record-commit.js"),
  ]);

  const snapshot = await readSetupConfigFileSnapshot();
  const snapshotConfig = requireValidSystemAgentSetupSnapshot(snapshot);

  if (hasExpectedConfigHash && resolveConfigSnapshotHash(snapshot) !== expectedConfigHash) {
    throw new Error("OpenClaw config changed while AI access was being tested. Try setup again.");
  }

  const guardModules =
    expectedAgentId || expectedAgentDir || expectedModelRef
      ? await Promise.all([
          import("../agents/agent-scope.js"),
          import("../agents/model-selection.js"),
        ] as const)
      : undefined;
  const assertExpectedTarget = (config: OpenClawConfig): void => {
    if (!guardModules) {
      return;
    }
    const [{ resolveAgentDir, resolveDefaultAgentId }, { resolveDefaultModelForAgent }] =
      guardModules;
    const currentAgentId = resolveDefaultAgentId(config);
    if (expectedAgentId && currentAgentId !== expectedAgentId) {
      throw new Error(
        "The default agent changed while AI access was being tested. Try setup again.",
      );
    }
    if (expectedAgentDir && resolveAgentDir(config, currentAgentId) !== expectedAgentDir) {
      throw new Error(
        "The agent credential location changed while AI access was being tested. Try setup again.",
      );
    }
    if (expectedModelRef) {
      const current = resolveDefaultModelForAgent({ cfg: config, agentId: currentAgentId });
      const currentModelRef = `${current.provider}/${current.model}`;
      if (currentModelRef !== expectedModelRef) {
        throw new Error(
          "The default model changed while AI access was being tested. Try setup again.",
        );
      }
    }
  };
  assertExpectedTarget(snapshotConfig.runtimeConfig);

  const assertVerifiedRoute = async (
    setupSnapshot: ConfigFileSnapshot,
    expectedRoute = params.expectedInferenceRoute,
    phase: "before" | "after" = "before",
  ) => {
    if (!expectedRoute) {
      return;
    }
    // Setup reads with plugin validation skipped so it can repair broken plugin
    // config. Bind that view to the fully validated path, root hash, includes,
    // resolved env, and exact route that produced the inference proof.
    const verifiedSnapshot = await readConfigFileSnapshot();
    const setupSource = setupSnapshot.exists
      ? (setupSnapshot.sourceConfig ?? setupSnapshot.config)
      : {};
    const verifiedSource = verifiedSnapshot.exists
      ? (verifiedSnapshot.sourceConfig ?? verifiedSnapshot.config)
      : {};
    const currentRoute =
      verifiedSnapshot.exists &&
      verifiedSnapshot.valid &&
      verifiedSnapshot.path === setupSnapshot.path &&
      verifiedSnapshot.hash === setupSnapshot.hash &&
      isDeepStrictEqual(verifiedSource, setupSource)
        ? await projectDefaultInferenceRoute(
            verifiedSnapshot.runtimeConfig ?? verifiedSnapshot.config,
          )
        : null;
    if (!currentRoute || !sameDefaultInferenceRoute(currentRoute, expectedRoute)) {
      throw new Error(
        phase === "before"
          ? "The default-agent inference route changed before setup could start, so no workspace or Gateway settings were changed. Retry setup from the current OpenClaw session."
          : "The default-agent inference route changed after the config write, so no further setup effects were applied. Retry setup from the current OpenClaw session.",
      );
    }
  };
  await assertVerifiedRoute(snapshot);

  const prompter = createQuickstartNotePrompter(runtime);
  const { configureGatewayForSetup } = await import("../wizard/setup.gateway-config.js");
  const buildSetupCandidate = async (currentBaseConfig: OpenClawConfig) => {
    let setupBaseConfig = currentBaseConfig;
    if (enablePluginId) {
      const enabled = enablePluginInConfig(setupBaseConfig, enablePluginId);
      if (!enabled.enabled) {
        throw new Error(`Provider plugin ${enablePluginId} is ${enabled.reason}.`);
      }
      setupBaseConfig = enabled.config;
    }
    if (configPatch !== undefined) {
      setupBaseConfig = applyMergePatch(setupBaseConfig, configPatch) as OpenClawConfig;
    }

    let candidate = applyLocalSetupWorkspaceConfig(setupBaseConfig, workspace);
    if (model) {
      candidate = await applySystemAgentModelSelection({
        config: candidate,
        model,
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        ...(authProfileId ? { authProfileId } : {}),
      });
    }
    candidate = applySecurityAcknowledgement(candidate);
    const gateway = await configureGatewayForSetup({
      flow: "quickstart",
      baseConfig: currentBaseConfig,
      nextConfig: candidate,
      localPort: resolveGatewayPort(currentBaseConfig),
      quickstartGateway: resolveQuickstartGatewayDefaults(currentBaseConfig),
      prompter,
      runtime,
    });
    return {
      nextConfig: onboardHelpers.applyWizardMetadata(gateway.nextConfig, {
        command: "onboard",
        mode: "local",
      }),
      settings: gateway.settings,
    };
  };
  const committed = await commit(
    async () =>
      await transformConfigWithPendingPluginInstalls({
        afterWrite: { mode: "auto" },
        writeOptions: { allowConfigSizeDrop: false },
        transform: async (currentConfig, context) => {
          const currentSnapshot = requireValidSystemAgentSetupSnapshot(context.snapshot);
          if (hasExpectedConfigHash && context.previousHash !== expectedConfigHash) {
            throw new Error(
              "OpenClaw config changed while AI access was being tested. Try setup again.",
            );
          }
          await assertVerifiedRoute(context.snapshot);
          assertExpectedTarget(currentSnapshot.runtimeConfig);

          // Rebuild config and Gateway settings from the same locked snapshot.
          // A retry can preserve unrelated concurrent edits without carrying
          // stale settings from the losing attempt into service setup or probes.
          const setupCandidate = await buildSetupCandidate(currentConfig);
          const finalizedConfig = finalizeConfig
            ? finalizeConfig(setupCandidate.nextConfig, currentSnapshot.sourceConfig)
            : setupCandidate.nextConfig;
          const expectedSourceRoute = params.expectedInferenceRoute
            ? await projectDefaultInferenceRoute(finalizedConfig)
            : undefined;
          if (
            params.expectedInferenceRoute &&
            (!params.expectedInferenceRoute.route ||
              !expectedSourceRoute?.route ||
              !isDeepStrictEqual(expectedSourceRoute.route, params.expectedInferenceRoute.route))
          ) {
            throw new Error(
              "The setup candidate no longer preserves the exact verified inference route, so it was not saved. Retry setup from the current OpenClaw session.",
            );
          }
          // This is the auth/config operation's linearization point. Never hold
          // the synchronous cross-store guard across async config I/O.
          assertCommitPreconditions?.();
          return {
            nextConfig: finalizedConfig,
            result: { settings: setupCandidate.settings },
          };
        },
      }),
  );
  const nextConfig = committed.nextConfig;
  const settings = committed.result?.settings;
  if (!settings) {
    throw new Error("OpenClaw setup committed without resolved Gateway settings.");
  }
  if (params.expectedInferenceRoute) {
    const afterRead = await readConfigFileSnapshotWithPluginMetadata();
    const afterSnapshot = afterRead.snapshot;
    requireValidSystemAgentSetupSnapshot(afterSnapshot);
    const expectedRuntime = validateConfigObjectWithPlugins(committed.nextConfig, {
      env: process.env,
      pluginMetadataSnapshot: afterRead.pluginMetadataSnapshot,
    });
    if (!expectedRuntime.ok) {
      const issue = expectedRuntime.issues[0];
      const detail = issue ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "";
      throw new Error(
        `OpenClaw could not validate the setup route after its config write${detail}. No further setup effects were applied. Retry setup from the current OpenClaw session.`,
      );
    }
    const expectedPersistedRoute = await projectDefaultInferenceRoute(expectedRuntime.config);
    await assertVerifiedRoute(afterSnapshot, expectedPersistedRoute, "after");
    // Plugin defaults are part of the access-tested runtime route. Reject a
    // metadata change that would make the committed config run differently.
    if (!isDeepStrictEqual(expectedPersistedRoute.route, params.expectedInferenceRoute.route)) {
      throw new Error(
        "The materialized inference route no longer matches the exact verified route, so no further setup effects were applied. Retry setup from the current OpenClaw session.",
      );
    }
  }

  const lines: string[] = [
    `Workspace: ${shortenHomePath(workspace)}`,
    model ? `Default model: ${model}` : undefined,
  ].filter((line): line is string => line !== undefined);

  const runCommittedFollowUp = async <T>(
    effect: () => Promise<T>,
    onFailure: (error: unknown) => void,
  ): Promise<T | undefined> => {
    let effectStarted = false;
    try {
      return await commit(async () => {
        effectStarted = true;
        return await effect();
      });
    } catch (error) {
      // The config commit is the success boundary, so effect failures are
      // visible but recoverable. A stale authority failure happens before the
      // effect starts and must stop every remaining continuation.
      if (!effectStarted) {
        throw error;
      }
      onFailure(error);
      return undefined;
    }
  };

  const workspaceResult = await runCommittedFollowUp(
    async () =>
      await onboardHelpers.ensureWorkspaceAndSessions(workspace, runtime, {
        skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
        skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
      }),
    (error) => lines.push(`Workspace files: ${formatErrorMessage(error)}`),
  );

  // Setup approval includes consent for OpenClaw's local model harnesses.
  // Keep the grant agent-scoped; regular agents retain interactive approvals.
  await runCommittedFollowUp(
    async () => {
      const { updateExecApprovals } = await import("../infra/exec-approvals.js");
      await updateExecApprovals({
        update: (approvals) =>
          approvals.agents?.openclaw
            ? null
            : {
                ...approvals,
                agents: {
                  ...approvals.agents,
                  openclaw: { security: "full", ask: "off" },
                },
              },
      });
    },
    (error) =>
      lines.push(
        `OpenClaw exec approval: ${formatErrorMessage(error)}; local model harnesses may ask again.`,
      ),
  );

  if (refreshPluginRegistry && enablePluginId) {
    await runCommittedFollowUp(
      async () => {
        const { refreshPluginRegistryAfterConfigMutation } =
          await import("../plugins/registry-refresh.js");
        await refreshPluginRegistryAfterConfigMutation({
          config: nextConfig,
          reason: "source-changed",
          workspaceDir: workspace,
          traceCommand: "openclaw-setup",
          logger: {
            warn: (message) => lines.push(message),
          },
        });
      },
      (error) => lines.push(`Plugin registry refresh failed: ${formatErrorMessage(error)}`),
    );
  }

  if (surface === "cli") {
    // The gateway daemon runs outside this process; install/start it so
    // channels and apps have a live gateway. Inside the gateway process
    // (macOS app chat) the app owns the service lifecycle.
    await runCommittedFollowUp(
      async () => {
        const { ensureGatewayServiceForOnboarding } = await import("../wizard/setup.finalize.js");
        const { installDaemon } = await ensureGatewayServiceForOnboarding({
          flow: "quickstart",
          opts: {},
          nextConfig,
          settings,
          prompter,
          runtime,
          loadedAction: "restart",
        });
        if (installDaemon) {
          const probeLinks = onboardHelpers.resolveLocalControlUiProbeLinks({
            bind: settings.bind,
            port: settings.port,
            customBindHost: settings.customBindHost,
            basePath: undefined,
            tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
          });
          const probe = await onboardHelpers.waitForGatewayReachable({
            url: probeLinks.wsUrl,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
            deadlineMs: 15_000,
          });
          lines.push(
            probe.ok
              ? `Gateway: running at ${probeLinks.wsUrl}`
              : `Gateway: not reachable yet (${probe.detail ?? "still starting"}) — say \`gateway status\` to check`,
          );
        } else {
          lines.push(
            "Gateway: service install skipped — say `start gateway` when you want it running.",
          );
        }
      },
      (error) => lines.push(`Gateway service: ${formatErrorMessage(error)}`),
    );
  } else {
    lines.push("Gateway: running (managed by this app).");
  }

  return {
    configPath: committed.path,
    configHashBefore: committed.previousHash,
    configHashAfter: committed.persistedHash,
    bootstrapPending: workspaceResult?.bootstrapPending === true,
    lines,
  };
}
