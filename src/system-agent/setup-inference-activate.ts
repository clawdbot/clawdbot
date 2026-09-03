// Activate one inference candidate: save its credential, stage the config in memory, confirm
// with one live turn, then commit. Credentials are saved and never rolled back; the config
// commit happens only after the turn succeeds, so a failing candidate leaves no broken default.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
} from "../commands/onboard-inference.js";
import { applyAutoLocalModelLean } from "../config/local-model-lean-auto.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginInConfig, enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import { resolveUserPath } from "../utils.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  type ActivateSetupInferenceParams,
  type ActivateSetupInferenceResult,
  AUTO_LOCAL_MODEL_LEAN_ANNOUNCEMENT,
  invalidSetupConfigError,
  parseProviderAutoSetupChoiceId,
  redactSetupInferenceError,
  resolveSetupInferenceWorkspace,
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
} from "./setup-inference-core.js";
import {
  parseRef,
  type StageContext,
  type StagedCandidate,
  type StageFailure,
  stageProviderAuthCandidate,
  stageProviderAutoCandidate,
} from "./setup-inference-credentials.js";
import {
  loadSetupInferencePluginGeneration,
  runSetupInferenceTurn,
} from "./setup-inference-turn.js";
import { applySystemAgentModelSelection } from "./setup-model-selection.js";

function resolveRouteModelRef(
  kind: string,
  requested: string | undefined,
  defaultModelRef: string,
): string | StageFailure {
  const modelRef = requested?.trim() || defaultModelRef;
  const selected = parseRef(modelRef);
  const expected = parseRef(defaultModelRef);
  if (
    !selected.model ||
    normalizeProviderId(selected.provider) !== normalizeProviderId(expected.provider)
  ) {
    return { error: `${modelRef} is not compatible with the ${kind} inference route.` };
  }
  return modelRef;
}

function resolveSetupAgentRuntimeId(kind: ActivateSetupInferenceParams["kind"]) {
  if (kind === "claude-cli") {
    return "claude-cli";
  }
  if (kind === "codex-cli") {
    return "codex";
  }
  if (kind === "gemini-cli" || kind === "existing-model") {
    return undefined;
  }
  return "openclaw";
}

/** Prepared Codex sign-in owns a local stdio app-server against the user's own Codex home. */
function configureCodexNativeAuth(cfg: OpenClawConfig): OpenClawConfig | StageFailure {
  const entry = cfg.plugins?.entries?.codex;
  const pluginConfig = entry?.config ?? {};
  const appServer =
    pluginConfig.appServer && typeof pluginConfig.appServer === "object"
      ? pluginConfig.appServer
      : {};
  const transport = "transport" in appServer ? appServer.transport : undefined;
  if (typeof transport === "string" && transport !== "stdio") {
    return {
      error: `Codex setup needs a local stdio app-server for prepared sign-in, but plugins.entries.codex.config.appServer.transport is "${transport}". Remove that transport override to let setup manage a local Codex, or finish Codex sign-in on the remote app-server host and retry.`,
    };
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        codex: {
          ...entry,
          config: {
            ...pluginConfig,
            appServer: { ...appServer, transport: "stdio", homeScope: "user" },
          },
        },
      },
    },
  };
}

async function stageCodexCandidate(ctx: StageContext): Promise<StagedCandidate | StageFailure> {
  const modelRef = resolveRouteModelRef(
    "codex-cli",
    ctx.params.modelRef,
    CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  );
  if (typeof modelRef !== "string") {
    return modelRef;
  }
  // Keep the reviewed package stable until the candidate config carries its install record.
  return await withPluginLifecycleLease({ signal: ctx.params.signal }, async () => {
    const enabled = await enablePluginWithCapabilityConsent(
      normalizePluginTargetConfig(ctx.cfg, "codex"),
      "codex",
      {
        workspaceDir: ctx.workspace,
        onCapabilityConsent: ctx.params.prompter
          ? createPluginCapabilityConsentPrompter(ctx.params.prompter)
          : undefined,
        beforePersistentEffect: ctx.beforePersistentEffect,
      },
    );
    if (!enabled.enabled) {
      return {
        error: `Could not enable the Codex runtime plugin: ${enabled.reason ?? "plugin disabled"}.`,
      };
    }
    const ensureCodex =
      ctx.deps.ensureCodexRuntimePlugin ??
      (await import("../commands/codex-runtime-plugin-install.js"))
        .ensureCodexRuntimePluginForModelSelection;
    const ensured = await ensureCodex({
      cfg: enabled.config,
      model: modelRef,
      agentId: ctx.routeAgentId,
      prompter: ctx.params.prompter ?? createQuickstartNotePrompter(ctx.params.runtime),
      runtime: ctx.params.runtime,
      workspaceDir: ctx.workspace,
      beforePersistentEffect: ctx.beforePersistentEffect,
    });
    if (!ensured.ok) {
      return { error: ensured.message };
    }
    const nativeAuth = configureCodexNativeAuth(normalizePluginTargetConfig(ensured.cfg, "codex"));
    if ("error" in nativeAuth) {
      return nativeAuth;
    }
    const enabledCodex = enablePluginInConfig(nativeAuth, "codex");
    if (!enabledCodex.enabled) {
      return {
        error: `Could not enable the Codex runtime plugin: ${enabledCodex.reason ?? "plugin disabled"}.`,
      };
    }
    // The just-installed package belongs to this candidate; the running Gateway keeps its
    // startup inventory until the committed config restarts it.
    const { refreshPluginRegistryAfterConfigMutation } =
      await import("../plugins/registry-refresh.js");
    await refreshPluginRegistryAfterConfigMutation({
      config: enabledCodex.config,
      reason: "source-changed",
      ...(enabledCodex.config.plugins?.installs
        ? { installRecords: enabledCodex.config.plugins.installs }
        : {}),
      workspaceDir: ctx.workspace,
      policyPluginIds: ["codex"],
      traceCommand: "openclaw-setup-probe",
      logger: { warn: () => undefined },
    });
    return { modelRef, agentRuntimeId: "codex", config: enabledCodex.config };
  });
}

async function stageCandidate(ctx: StageContext): Promise<StagedCandidate | StageFailure> {
  const { params, cfg } = ctx;
  const providerAutoChoiceId = parseProviderAutoSetupChoiceId(params.kind);
  if (providerAutoChoiceId) {
    return await stageProviderAutoCandidate(ctx, providerAutoChoiceId);
  }
  switch (params.kind) {
    case "existing-model": {
      const route = await resolveSystemAgentConfiguredRouteFromConfig(cfg, params.agentId, {
        loadAuthProfileStoreForRuntime: ctx.deps.loadAuthProfileStoreForRuntime,
      });
      if (!route) {
        return { error: "No configured default-agent inference route is available." };
      }
      const requested = params.modelRef?.trim();
      if (requested && normalizeAgentModelRefForConfig(requested) !== route.modelLabel) {
        return {
          error: `The configured default model changed from ${requested} to ${route.modelLabel}. Try setup again.`,
        };
      }
      return { modelRef: route.modelLabel, config: cfg };
    }
    case "claude-cli": {
      const modelRef = resolveRouteModelRef(
        params.kind,
        params.modelRef,
        CLAUDE_CLI_DEFAULT_MODEL_REF,
      );
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      // Backend metadata owns whether a CLI runtime aliases a canonical provider.
      const persistProvider =
        resolveCliRuntimeCanonicalProvider({
          runtime: ref.provider,
          config: cfg,
          env: process.env,
          includeSetupRegistry: true,
        }) ?? ref.provider;
      return {
        modelRef: `${persistProvider}/${ref.model}`,
        agentRuntimeId: "claude-cli",
        config: cfg,
      };
    }
    case "gemini-cli":
    case "openai-api-key":
    case "anthropic-api-key": {
      const defaults = {
        "gemini-cli": GEMINI_CLI_DEFAULT_MODEL_REF,
        "openai-api-key": OPENAI_API_DEFAULT_MODEL_REF,
        "anthropic-api-key": ANTHROPIC_API_DEFAULT_MODEL_REF,
      };
      const modelRef = resolveRouteModelRef(params.kind, params.modelRef, defaults[params.kind]);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const agentRuntimeId = resolveSetupAgentRuntimeId(params.kind);
      return { modelRef, ...(agentRuntimeId ? { agentRuntimeId } : {}), config: cfg };
    }
    case "codex-cli":
      return await stageCodexCandidate(ctx);
    case "api-key":
      return await stageProviderAuthCandidate(ctx, false);
    case "provider-auth":
      return await stageProviderAuthCandidate(ctx, true);
    default:
      return { error: `Unknown inference choice "${params.kind}".` };
  }
}

/** Test one candidate with a real completion, then persist it as the setup default. */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  try {
    const result = await activateSetupInferenceUnredacted(params);
    if (result.ok) {
      return {
        ...result,
        lines: await Promise.all(
          result.lines.map((line) => redactSetupInferenceError(line, params.apiKey)),
        ),
      };
    }
    return { ...result, error: await redactSetupInferenceError(result.error, params.apiKey) };
  } catch (error) {
    const redacted = await redactSetupInferenceError(formatErrorMessage(error), params.apiKey);
    if (error instanceof WizardCancelledError) {
      throw new WizardCancelledError(redacted);
    }
    if (error instanceof WizardNavigationError) {
      throw new WizardNavigationError(error.direction);
    }
    if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
      return { ok: false, status: "unavailable", error: "Provider login was cancelled." };
    }
    // oxlint-disable-next-line preserve-caught-error -- The original cause can contain the submitted setup secret.
    throw new Error(redacted);
  }
}

async function activateSetupInferenceUnredacted(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const deps = params.deps ?? {};
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  // Missing-file snapshots still carry the load-time implicit-main roster.
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const ctx: StageContext = {
    params,
    deps,
    cfg,
    routeAgentId: resolveAmbientOwnerAgentId(cfg, params.agentId),
    agentDir: resolveAgentDir(cfg, resolveAmbientOwnerAgentId(cfg, params.agentId)),
    workspace: params.workspace?.trim()
      ? resolveUserPath(params.workspace)
      : resolveSetupInferenceWorkspace(snapshot),
    beforePersistentEffect: async () => {
      throwIfSetupInferenceCancelled(params);
      await params.beforePersistentEffect?.();
      throwIfSetupInferenceCancelled(params);
    },
  };
  const staged = await stageCandidate(ctx);
  if ("error" in staged) {
    return { ok: false, status: "unavailable", error: staged.error };
  }
  const requestedAgentId = params.agentId ? ctx.routeAgentId : undefined;
  // Provider-side changes were prepared against the runtime config; replay them onto whatever
  // config the writer holds at commit time instead of overwriting concurrent edits.
  const providerPatch = createMergePatch(cfg, staged.config);
  const selectModel = async (config: OpenClawConfig) =>
    await applySystemAgentModelSelection({
      config,
      model: staged.modelRef,
      ...(params.agentId ? { targetAgentId: ctx.routeAgentId } : {}),
      ...(staged.agentRuntimeId ? { agentRuntimeId: staged.agentRuntimeId } : {}),
    });
  const provider = parseRef(staged.modelRef).provider;
  const buildCandidate = async (base: OpenClawConfig) => {
    const patched = applyMergePatch(base, providerPatch) as OpenClawConfig;
    const lean = applyAutoLocalModelLean({
      config: patched,
      providerId: provider,
      modelRef: staged.modelRef,
    });
    return {
      config: params.kind === "existing-model" ? lean.config : await selectModel(lean.config),
      leanEnabled: lean.enabled,
      changed: lean.changed || params.kind !== "existing-model",
    };
  };
  const candidate = await buildCandidate(cfg);
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    candidate.config,
    requestedAgentId,
    {
      loadAuthProfileStoreForRuntime: deps.loadAuthProfileStoreForRuntime,
    },
  );
  if (!route || route.modelLabel !== staged.modelRef) {
    return {
      ok: false,
      status: "unavailable",
      error:
        "The staged default-agent route does not match the requested inference candidate. Review model runtime policy and retry.",
    };
  }
  throwIfSetupInferenceCancelled(params);
  const progress = params.prompter?.progress("Testing your AI connection…");
  let turn: Awaited<ReturnType<typeof runSetupInferenceTurn>>;
  try {
    const runTurn = () =>
      runSetupInferenceTurn({
        route,
        deps,
        requireExecutionOwner: false,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    // A freshly installed Codex package is only visible to a generation loaded after the install.
    turn =
      staged.agentRuntimeId === "codex"
        ? await withPluginRuntimeGenerationScope(
            loadSetupInferencePluginGeneration({
              config: candidate.config,
              workspaceDir: ctx.workspace,
              selection: {
                provider: route.provider,
                modelId: route.model,
                runtime: "codex",
                agentId: route.agentId,
              },
            }),
            runTurn,
          )
        : await runTurn();
    throwIfSetupInferenceCancelled(params);
  } finally {
    progress?.stop();
  }
  if (!turn.ok) {
    return turn;
  }
  let gatewayRestartRequired = false;
  let leanAnnounced = false;
  if (candidate.changed) {
    progress?.update("Finishing AI setup…");
    const application = params.onRuntimeApplication
      ? createRuntimeConfigWriteApplication(captureGatewayRootWorkAdmissionContinuationScope()?.run)
      : undefined;
    if (application) {
      params.onRuntimeApplication?.(application);
    }
    const transformConfig =
      deps.transformConfigWithPendingPluginInstalls ??
      (await import("../plugins/install-record-commit.js"))
        .transformConfigWithPendingPluginInstalls;
    throwIfSetupInferenceCancelled(params);
    const committed = await transformConfig({
      base: "source",
      ...(application
        ? { writeOptions: attachRuntimeConfigWriteApplication({}, application) }
        : {}),
      transform: async (current) => {
        const next = await buildCandidate(current);
        throwIfSetupInferenceCancelled(params);
        params.onCommitStarted?.(current);
        leanAnnounced = next.leanEnabled;
        return { nextConfig: next.config };
      },
    });
    gatewayRestartRequired = committed.followUp.requiresRestart;
  }
  let lines = [
    `Inference verified: ${staged.modelRef}`,
    ...(leanAnnounced ? [AUTO_LOCAL_MODEL_LEAN_ANNOUNCEMENT] : []),
  ];
  if (params.surface === "gateway" && params.recordSetupAudit !== false) {
    const after = await readSnapshot().catch(() => null);
    try {
      await appendSystemAgentAuditEntry({
        operation: "openclaw.setup",
        summary: "Verified and configured AI access through OpenClaw setup",
        configPath: after?.path ?? snapshot.path,
        configHashBefore: snapshot.hash ?? null,
        configHashAfter: after?.hash ?? null,
        details: { modelRef: staged.modelRef, inferenceKind: params.kind },
      });
    } catch (error) {
      // The route is already verified and durable; an audit failure is a warning, not a failure.
      const warning = `Inference setup completed, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
      params.runtime.error?.(warning);
      lines = [...lines, warning];
    }
  }
  return {
    ok: true,
    modelRef: staged.modelRef,
    latencyMs: turn.latencyMs,
    lines,
    ...(params.surface === "gateway" && gatewayRestartRequired
      ? { gatewayRestartRequired: true as const }
      : {}),
  };
}
