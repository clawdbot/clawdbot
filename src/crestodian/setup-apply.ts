// Applies Crestodian's conversational setup: config, workspace files, gateway.
import { resolveGatewayPort } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
};

export type CrestodianSetupApplyResult = {
  configPath: string;
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
  let models: Record<string, AgentModelEntryConfig>;
  if (writesAgent) {
    const agent = nextConfig.agents?.list?.find((entry) => normalizeAgentId(entry.id) === agentId);
    if (!agent) {
      throw new Error(`Could not resolve configured default agent "${agentId}".`);
    }
    models = { ...agent.models };
    agent.models = models;
  } else {
    nextConfig.agents ??= {};
    nextConfig.agents.defaults ??= {};
    models = { ...nextConfig.agents.defaults.models };
    nextConfig.agents.defaults.models = models;
  }
  const target = modelConfig.resolveModelTarget({ raw: params.model, cfg: nextConfig });
  const key = modelConfig.upsertCanonicalModelConfigEntry(models, target);
  if (params.agentRuntimeId) {
    models[key] = {
      ...models[key],
      agentRuntime: { id: params.agentRuntimeId },
    };
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
      // An inherited primary can still have higher-priority per-agent model
      // metadata. Pin the selected runtime at that owner as well.
      const agent = nextConfig.agents?.list?.find(
        (entry) => normalizeAgentId(entry.id) === agentId,
      );
      if (!agent) {
        throw new Error(`Could not resolve configured default agent "${agentId}".`);
      }
      const agentModels = { ...agent.models };
      const agentKey = modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
      agentModels[agentKey] = {
        ...agentModels[agentKey],
        agentRuntime: { id: params.agentRuntimeId },
      };
      agent.models = agentModels;
    }
  }
  return nextConfig;
}

export async function applyCrestodianSetup(
  params: CrestodianSetupApplyParams,
): Promise<CrestodianSetupApplyResult> {
  const { workspace, model, surface, runtime } = params;
  const [
    { readSetupConfigFileSnapshot, resolveQuickstartGatewayDefaults, writeWizardConfigFile },
    onboardHelpers,
    { applyLocalSetupWorkspaceConfig },
  ] = await Promise.all([
    import("../wizard/setup.shared.js"),
    import("../commands/onboard-helpers.js"),
    import("../commands/onboard-config.js"),
  ]);

  const snapshot = await readSetupConfigFileSnapshot();
  const baseConfig: OpenClawConfig =
    snapshot.valid && snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};

  let nextConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspace);
  if (model) {
    nextConfig = await applyCrestodianModelSelection({
      config: nextConfig,
      model,
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
  nextConfig = await writeWizardConfigFile(nextConfig, {
    allowConfigSizeDrop: false,
    migrationBaseConfig: baseConfig,
  });

  await onboardHelpers.ensureWorkspaceAndSessions(workspace, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
    skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
  });

  // The user's explicit setup approval (with the security note shown up
  // front) is the consent for Crestodian's own agent loop to run local model
  // harnesses (Codex app-server needs exec). Scope the grant to the
  // crestodian agent only; regular agents keep the interactive approval flow.
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
    runtime.log(
      `Could not record Crestodian exec approval (${error instanceof Error ? error.message : String(error)}); local model harnesses may ask again.`,
    );
  }

  const lines: string[] = [
    `Workspace: ${shortenHomePath(workspace)}`,
    model ? `Default model: ${model}` : undefined,
  ].filter((line): line is string => line !== undefined);

  if (surface === "cli") {
    // The gateway daemon runs outside this process; install/start it so
    // channels and apps have a live gateway. Inside the gateway process
    // (macOS app chat) the app owns the service lifecycle.
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
  } else {
    lines.push("Gateway: running (managed by this app).");
  }

  return { configPath: snapshot.path, lines };
}
