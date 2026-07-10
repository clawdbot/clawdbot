// Applies Crestodian's conversational setup: config, workspace files, gateway.
import { resolveConfigSnapshotHash, resolveGatewayPort } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * The whole first-run setup as one approved operation: the user says "yes" in
 * the conversation and this applies model + workspace + quickstart gateway
 * defaults, seeds workspace bootstrap files, and (on the CLI surface) installs
 * and starts the gateway service. No interactive prompts may occur here —
 * everything uses quickstart defaults, so the conversation stays the only UI.
 */
export type CrestodianSetupApplyParams = {
  workspace: string;
  model?: string;
  agentRuntimeId?: string;
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
  /** Plugin whose enablement belongs to the successful setup transaction. */
  enablePluginId?: string;
  /** Refresh an installed plugin after its success-gated enablement commits. */
  refreshPluginRegistry?: boolean;
  /** Synchronous cross-store guard checked under the final config write lock. */
  assertCommitPreconditions?: () => void;
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
};

export type CrestodianSetupApplyResult = {
  configPath: string;
  configHashBefore: string | null;
  configHashAfter: string | null;
  lines: string[];
};

/** Prompter for quickstart-only flows: notes go to the log, prompts fail loud. */
export function createQuickstartNotePrompter(runtime: RuntimeEnv): WizardPrompter {
  const unexpected = (kind: string) => {
    throw new Error(`crestodian setup hit an interactive ${kind} prompt; quickstart must not ask`);
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

export async function applyCrestodianModelSelection(params: {
  config: OpenClawConfig;
  model: string;
  agentRuntimeId?: string;
}): Promise<OpenClawConfig> {
  const [agentScope, modelConfig, runtimePolicy] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../commands/models/shared.js"),
    import("../agents/model-runtime-policy.js"),
  ]);
  const nextConfig = structuredClone(params.config);
  const agentId = agentScope.resolveDefaultAgentId(nextConfig);
  const writesAgent = Boolean(agentScope.resolveAgentExplicitModelPrimary(nextConfig, agentId));
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
  }

  agentScope.setAgentEffectiveModelPrimary(nextConfig, agentId, key);
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

export async function applyCrestodianSetup(
  params: CrestodianSetupApplyParams,
): Promise<CrestodianSetupApplyResult> {
  const {
    workspace,
    model,
    agentRuntimeId,
    expectedAgentId,
    expectedAgentDir,
    expectedModelRef,
    expectedConfigHash,
    configPatch,
    enablePluginId,
    refreshPluginRegistry,
    assertCommitPreconditions,
    surface,
    runtime,
  } = params;
  const hasExpectedConfigHash = Object.hasOwn(params, "expectedConfigHash");
  const [
    { mergeWizardConfigOntoLatest, readSetupConfigFileSnapshot, resolveQuickstartGatewayDefaults },
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
  if (snapshot.exists && !snapshot.valid) {
    const issue = snapshot.issues?.[0];
    const detail = issue ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "";
    throw new Error(
      `OpenClaw config ${shortenHomePath(snapshot.path)} is invalid${detail}. Fix it before running setup.`,
    );
  }
  const baseConfig: OpenClawConfig = snapshot.exists
    ? (snapshot.sourceConfig ?? snapshot.config)
    : {};

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
  assertExpectedTarget(snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {});

  let setupBaseConfig = baseConfig;
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

  let nextConfig = applyLocalSetupWorkspaceConfig(setupBaseConfig, workspace);
  if (model) {
    nextConfig = await applyCrestodianModelSelection({
      config: nextConfig,
      model,
      ...(agentRuntimeId ? { agentRuntimeId } : {}),
    });
  }
  nextConfig = applySecurityAcknowledgement(nextConfig);

  const prompter = createQuickstartNotePrompter(runtime);
  const { configureGatewayForSetup } = await import("../wizard/setup.gateway-config.js");
  const gateway = await configureGatewayForSetup({
    flow: "quickstart",
    baseConfig,
    nextConfig,
    localPort: resolveGatewayPort(baseConfig),
    quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig),
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
    command: "onboard",
    mode: "local",
  });

  const committed = await transformConfigWithPendingPluginInstalls({
    afterWrite: { mode: "auto" },
    writeOptions: { allowConfigSizeDrop: false },
    transform: (currentConfig, context) => {
      if (!context.snapshot.valid) {
        throw new Error(
          `OpenClaw config ${shortenHomePath(context.snapshot.path)} became invalid during setup. Fix it and try again.`,
        );
      }
      if (hasExpectedConfigHash && context.previousHash !== expectedConfigHash) {
        throw new Error(
          "OpenClaw config changed while AI access was being tested. Try setup again.",
        );
      }
      assertExpectedTarget(
        context.snapshot.exists ? (context.snapshot.runtimeConfig ?? currentConfig) : currentConfig,
      );
      // This is the auth/config operation's linearization point: an auth write
      // that wins before it aborts setup; an overlapping write after it is
      // ordered after setup, exactly like a credential change after return.
      // Never hold the synchronous SQLite transaction across async config I/O.
      assertCommitPreconditions?.();
      return {
        nextConfig: mergeWizardConfigOntoLatest(currentConfig, baseConfig, nextConfig),
      };
    },
  });
  nextConfig = committed.nextConfig;

  const lines: string[] = [
    `Workspace: ${shortenHomePath(workspace)}`,
    model ? `Default model: ${model}` : undefined,
  ].filter((line): line is string => line !== undefined);

  // The config commit is the setup success boundary. Follow-up materialization
  // cannot be rolled back safely, so expose any failures without reporting the
  // already-committed setup as failed.
  try {
    await onboardHelpers.ensureWorkspaceAndSessions(workspace, runtime, {
      skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
      skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
    });
  } catch (error) {
    lines.push(`Workspace files: ${formatErrorMessage(error)}`);
  }

  // Setup approval includes consent for Crestodian's local model harnesses.
  // Keep the grant agent-scoped; regular agents retain interactive approvals.
  try {
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    await updateExecApprovals({
      update: (approvals) =>
        approvals.agents?.crestodian
          ? null
          : {
              ...approvals,
              agents: {
                ...approvals.agents,
                crestodian: { security: "full", ask: "off" },
              },
            },
    });
  } catch (error) {
    lines.push(
      `Crestodian exec approval: ${formatErrorMessage(error)}; local model harnesses may ask again.`,
    );
  }

  if (refreshPluginRegistry && enablePluginId) {
    try {
      const { refreshPluginRegistryAfterConfigMutation } =
        await import("../plugins/registry-refresh.js");
      await refreshPluginRegistryAfterConfigMutation({
        config: nextConfig,
        reason: "source-changed",
        workspaceDir: workspace,
        traceCommand: "crestodian-setup",
        logger: {
          warn: (message) => lines.push(message),
        },
      });
    } catch (error) {
      lines.push(`Plugin registry refresh failed: ${formatErrorMessage(error)}`);
    }
  }

  if (surface === "cli") {
    // The gateway daemon runs outside this process; install/start it so
    // channels and apps have a live gateway. Inside the gateway process
    // (macOS app chat) the app owns the service lifecycle.
    try {
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
    } catch (error) {
      lines.push(`Gateway service: ${formatErrorMessage(error)}`);
    }
  } else {
    lines.push("Gateway: running (managed by this app).");
  }

  return {
    configPath: committed.path,
    configHashBefore: committed.previousHash,
    configHashAfter: committed.persistedHash,
    lines,
  };
}
