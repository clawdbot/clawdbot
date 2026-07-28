// Shared execution helpers keep the public dispatcher small and reviewable.
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { OpenClawConfig } from "../config/config.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import {
  SYSTEM_AGENT_CONFIG_WRITE_DENYLIST,
  classifyInferenceRouteConfigPath,
  type InferenceRoutePathVerdict,
} from "./config-write-policy.js";
import {
  projectDefaultInferenceRoute,
  projectInferenceRoute,
  sameDefaultInferenceRoute,
  type DefaultInferenceRouteProjection,
} from "./inference-route.js";
import type {
  SystemAgentCommandDeps,
  SystemAgentOperation,
  SystemAgentOperationResult,
} from "./operations-parse.js";
import { formatSystemAgentPersistentPlan } from "./operations-parse.js";
import type { SystemAgentOverview } from "./overview.js";
import { validateSystemAgentPluginInstallSpec } from "./plugin-install.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

type ConfigModule = typeof import("../config/config.js");
type ConfigFileSnapshot = Awaited<ReturnType<ConfigModule["readConfigFileSnapshot"]>>;
const loadConfigModule = async () => await import("../config/config.js");
const loadOverviewModule = async () => await import("./overview.js");

export const CONFIG_GET_OUTPUT_MAX_CHARS = 2_000;
export const CONFIG_SCHEMA_CHILDREN_MAX = 40;

export function redactConfigValue(value: unknown, configPath: string): unknown {
  if (typeof value === "string" || typeof value === "number") {
    return isSensitiveConfigPath(configPath) ? "<redacted>" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfigValue(entry, `${configPath}[]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactConfigValue(entry, configPath ? `${configPath}.${key}` : key),
      ]),
    );
  }
  return value;
}

export function readConfigValueAtPath(
  config: unknown,
  path: string,
): { found: boolean; value?: unknown } {
  let current: unknown = config;
  for (const rawSegment of path.split(".")) {
    // Support foo[0] style array segments alongside dotted keys.
    const parts = rawSegment.split(/[[\]]/).filter(Boolean);
    for (const part of parts) {
      if (current === null || typeof current !== "object") {
        return { found: false };
      }
      const index = /^\d+$/.test(part) ? Number(part) : undefined;
      if (index !== undefined && Array.isArray(current)) {
        current = current[index];
      } else {
        current = (current as Record<string, unknown>)[part];
      }
      if (current === undefined) {
        return { found: false };
      }
    }
  }
  return { found: true, value: current };
}

export function formatGatewayStatusLine(overview: SystemAgentOverview): string {
  return [
    `Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"}`,
    `URL: ${overview.gateway.url}`,
    `Source: ${overview.gateway.source}`,
    overview.gateway.error ? `Note: ${overview.gateway.error}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function runGatewayLifecycle(
  operation: "start" | "stop" | "restart",
): Promise<void | boolean> {
  const lifecycle = await import("../cli/daemon-cli/lifecycle.js");
  if (operation === "start") {
    await lifecycle.runDaemonStart();
    return;
  }
  if (operation === "stop") {
    // The system-agent approval gate is the non-interactive equivalent of an
    // operator passing --force after explicitly approving the mutation.
    await lifecycle.runDaemonStop({ force: true });
    return;
  }
  return await lifecycle.runDaemonRestart();
}

export async function readConfigFileSnapshotLazy(): Promise<ConfigFileSnapshot> {
  const { readConfigFileSnapshot } = await loadConfigModule();
  return await readConfigFileSnapshot();
}

export async function loadOverviewForOperation(
  deps: SystemAgentCommandDeps | undefined,
): Promise<SystemAgentOverview> {
  if (deps?.loadOverview) {
    return await deps.loadOverview();
  }
  const { loadSystemAgentOverview } = await loadOverviewModule();
  return await loadSystemAgentOverview();
}

export async function resolveChannelSetupState(deps: SystemAgentCommandDeps | undefined) {
  const listPlugins =
    deps?.listChannelSetupPlugins ??
    (await import("../channels/plugins/setup-registry.js")).listChannelSetupPlugins;
  const resolveEntries =
    deps?.resolveChannelSetupEntries ??
    (await import("../commands/channel-setup/discovery.js")).resolveChannelSetupEntries;
  const isConfigured =
    deps?.isChannelConfigured ??
    (await import("../config/channel-configured-shared.js")).isStaticallyChannelConfigured;
  const { shouldShowChannelInSetup } = await import("../commands/channel-setup/discovery.js");
  const snapshot = await readConfigFileSnapshotLazy();
  const cfg = snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const installedPlugins = listPlugins();
  const resolved = resolveEntries({ cfg, installedPlugins });
  return {
    cfg,
    installedPlugins,
    resolved: {
      ...resolved,
      // Match the connect/list surfaces: setup-hidden channels stay invisible
      // to chat listings and channel info alike.
      entries: resolved.entries.filter((entry) => shouldShowChannelInSetup(entry.meta)),
    },
    isConfigured,
  };
}

export function formatChannelDocsUrl(docsPath: string): string {
  return `https://docs.openclaw.ai${docsPath.startsWith("/") ? docsPath : `/${docsPath}`}`;
}

export function formatConfigValidationLine(snapshot: ConfigFileSnapshot): string {
  if (!snapshot.exists) {
    return `Config missing: ${shortenHomePath(snapshot.path)}`;
  }
  if (snapshot.valid) {
    return `Config valid: ${shortenHomePath(snapshot.path)}`;
  }
  return [
    `Config invalid: ${shortenHomePath(snapshot.path)}`,
    ...snapshot.issues.map((issue) => {
      const issuePath = issue.path ? `${issue.path}: ` : "";
      return `  - ${issuePath}${issue.message}`;
    }),
  ].join("\n");
}

export function createNoExitRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code) => {
      throw new Error(`operation exited with code ${code}`);
    },
  };
}

export async function resolveTuiAgentId(params: {
  requestedAgentId: string | undefined;
  requestedWorkspace?: string;
  deps?: SystemAgentCommandDeps;
}): Promise<string | undefined> {
  const overview = await loadOverviewForOperation(params.deps);
  const workspace = params.requestedWorkspace
    ? resolveUserPath(params.requestedWorkspace)
    : undefined;
  if (workspace) {
    const workspaceMatch = overview.agents.find((agent) => {
      return agent.workspace ? resolveUserPath(agent.workspace) === workspace : false;
    });
    if (workspaceMatch) {
      return workspaceMatch.id;
    }
  }
  if (!params.requestedAgentId?.trim()) {
    return overview.defaultAgentId;
  }
  const requested = normalizeAgentId(params.requestedAgentId);
  const match = overview.agents.find((agent) => {
    return (
      normalizeAgentId(agent.id) === requested ||
      (agent.name ? normalizeAgentId(agent.name) === requested : false)
    );
  });
  return match?.id ?? requested;
}

export type ExecuteOptions = {
  approved?: boolean;
  deps?: SystemAgentCommandDeps;
  auditDetails?: Record<string, unknown>;
  /**
   * Authority check used by the guarded commit seam for host-approved writes.
   * A multi-step operation may invoke it more than once; every invocation is
   * immediately followed by the persistent effect it authorizes.
   */
  beforePersistentApply?: () => Promise<void>;
  /** Adopt the exact final binding after a verified model-route write commits. */
  onVerifiedInferenceChanged?: (binding: SystemAgentVerifiedInferenceBinding) => void;
};

/**
 * One persistent operation = one audited apply. The shared wrapper owns the
 * approval gate, before/after config hashes, the audit record, and the
 * `[openclaw] running/done` markers the e2e lanes assert on; each spec only
 * describes what to run and what to record.
 */
type PersistentApplyContext = {
  runtime: RuntimeEnv;
  deps?: SystemAgentCommandDeps;
  /** Re-check authority, then enter one persistent side-effect boundary. */
  commit<T>(effect: () => Promise<T> | T): Promise<T>;
};

type PersistentApplyOutcome = {
  summary: string;
  bootstrapPending?: boolean;
  agentId?: string;
  details?: Record<string, unknown>;
  /** Overrides the after-snapshot config path in the audit record. */
  configPath?: string;
};

export async function applyPersistentOperation(params: {
  auditOperation: string;
  operation: SystemAgentOperation;
  runtime: RuntimeEnv;
  opts: ExecuteOptions;
  run: (ctx: PersistentApplyContext) => Promise<PersistentApplyOutcome>;
}): Promise<SystemAgentOperationResult> {
  const { auditOperation, runtime, opts } = params;
  if (!opts.approved) {
    const message = formatSystemAgentPersistentPlan(params.operation);
    runtime.log(message);
    return { applied: false, message };
  }
  runtime.log(`[openclaw] running: ${auditOperation}`);
  const { readConfigFileSnapshot } = await loadConfigModule();
  const before = await readConfigFileSnapshot();
  const commit: PersistentApplyContext["commit"] = async (effect) => {
    await opts.beforePersistentApply?.();
    return await effect();
  };
  const outcome = await params.run({ runtime, deps: opts.deps, commit });
  const after = await readConfigFileSnapshot();
  try {
    await appendSystemAgentAuditEntry({
      operation: auditOperation,
      summary: outcome.summary,
      configPath: outcome.configPath ?? after.path ?? before.path ?? undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: { ...opts.auditDetails, ...outcome.details },
    });
  } catch (error) {
    // The mutation already committed. Keep success truthful while making the
    // missing audit record visible to every CLI/chat capture surface.
    runtime.error(
      `${outcome.summary}, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`,
    );
  }
  runtime.log(`[openclaw] done: ${auditOperation}`);
  return {
    applied: true,
    ...(outcome.bootstrapPending === undefined
      ? {}
      : { bootstrapPending: outcome.bootstrapPending }),
    ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
  };
}

export async function runConfigSetOperation(params: {
  operation: Extract<SystemAgentOperation, { kind: "config-set" | "config-set-ref" }>;
  ctx: PersistentApplyContext;
}): Promise<void> {
  const { operation, ctx } = params;
  const runConfigSet =
    ctx.deps?.runConfigSet ??
    (async (setOpts: { path?: string; value?: string; cliOptions: ConfigSetOptions }) => {
      const { runConfigSet: importedRunConfigSet } = await import("../cli/config-cli.js");
      await importedRunConfigSet({
        ...setOpts,
        runtime: createNoExitRuntime(ctx.runtime),
      });
    });
  if (operation.kind === "config-set") {
    await ctx.commit(async () => {
      // Conditional verdicts (per-agent routing, plugin entries) depend on the
      // current config; a concurrent edit can flip them between the
      // pre-approval check and this write. Re-verify at the commit boundary,
      // like the plugin-uninstall path.
      await assertConfigWriteDoesNotBypassInferenceVerification(operation);
      await runConfigSet({ path: operation.path, value: operation.value, cliOptions: {} });
    });
    return;
  }
  await ctx.commit(async () => {
    await assertConfigWriteDoesNotBypassInferenceVerification(operation);
    await runConfigSet({
      path: operation.path,
      cliOptions: {
        refProvider: operation.provider ?? "default",
        refSource: operation.source,
        refId: operation.id,
      },
    });
  });
}

async function isDefaultAgentListPath(segments: readonly string[]): Promise<boolean> {
  const listIndexSegment = segments
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)[2];
  if (!listIndexSegment || !/^\d+$/.test(listIndexSegment)) {
    // Path addresses agents.list.<field> without an index; fail closed.
    return true;
  }
  const { readConfigFileSnapshot } = await loadConfigModule();
  const { resolveDefaultAgentId } = await import("../agents/agent-scope.js");
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return true;
  }
  const config = snapshot.sourceConfig ?? snapshot.config;
  const authoredList = snapshot.sourceConfigBeforeMigrations?.agents?.list;
  const entry = Array.isArray(authoredList) ? authoredList[Number(listIndexSegment)] : undefined;
  if (!entry?.id) {
    // Unknown or id-less entry: cannot prove it is off the default route.
    return true;
  }
  const defaultAgentId = resolveDefaultAgentId(config ?? {});
  return normalizeAgentId(entry.id) === normalizeAgentId(defaultAgentId);
}

export async function assertConfigWriteDoesNotBypassInferenceVerification(
  operation: Extract<SystemAgentOperation, { kind: "config-set" | "config-set-ref" }>,
): Promise<void> {
  const { parseConfigSetPath } = await import("../cli/config-cli.js");
  const segments = parseConfigSetPath(operation.path);
  const verdict: InferenceRoutePathVerdict = classifyInferenceRouteConfigPath(segments);
  if (verdict === "allowed") {
    return;
  }
  // Per-agent routing overrides are fine for agents that do not back the
  // default/system route: they cannot break the inference powering this
  // session, and set_default_model live-tests the default route instead.
  if (verdict === "agent-route" && !(await isDefaultAgentListPath(segments))) {
    return;
  }
  // Same invariant as plugin_uninstall: a plugins.entries write may not touch
  // the plugin backing the active default route (e.g. disabling it).
  if (verdict === "plugin-entry") {
    const pluginId = segments.filter((segment) => segment.trim())[2] ?? "";
    if (!(await isPluginBackingDefaultInferenceRoute(pluginId))) {
      return;
    }
    throw new Error(
      `Direct config writes cannot change plugin "${pluginId}" because it may back OpenClaw's own active inference route. Exit OpenClaw and edit it from a terminal.`,
    );
  }
  const deniedRoot = segments[0]?.trim().toLowerCase() ?? "";
  const denialReason = SYSTEM_AGENT_CONFIG_WRITE_DENYLIST[deniedRoot];
  throw new Error(
    denialReason
      ? `Direct config writes cannot change \`${deniedRoot}\` (${denialReason}).`
      : "Direct config writes cannot change the default inference route or include alternate config. Use `set_default_model` (optionally with agentId) for an already configured route, or exit OpenClaw and run `openclaw onboard` to change provider/auth access.",
  );
}

async function verifyCurrentSetupInference(
  runtime: RuntimeEnv,
  deps?: SystemAgentCommandDeps,
): Promise<{
  modelRef: string;
  route: DefaultInferenceRouteProjection;
  latencyMs: number;
}> {
  const { readConfigFileSnapshot } = await loadConfigModule();
  const before = await readConfigFileSnapshot();
  if (!before.exists || !before.valid) {
    throw new Error(
      "OpenClaw setup requires a valid configured inference route. Exit OpenClaw and run `openclaw onboard`, then retry.",
    );
  }
  const beforeConfig = before.runtimeConfig ?? before.config;
  const beforeRoute = await projectDefaultInferenceRoute(beforeConfig);
  if (!beforeRoute.route) {
    throw new Error(
      "OpenClaw setup requires working inference first. Exit OpenClaw and run `openclaw onboard`, then retry.",
    );
  }
  const verifyInferenceConfig =
    deps?.verifyInferenceConfig ??
    (await import("./setup-inference.js")).verifySetupInferenceConfig;
  const verification = await verifyInferenceConfig({ config: beforeConfig, runtime });
  if (!verification.ok) {
    throw new Error(
      `OpenClaw setup requires working inference first. The configured route failed a live check: ${verification.error} Exit OpenClaw and run \`openclaw onboard\`, then retry.`,
    );
  }

  const after = await readConfigFileSnapshot();
  if (!after.exists || !after.valid) {
    throw new Error(
      "The default-agent inference route changed during setup verification, so setup was not applied. Review the current config and retry.",
    );
  }
  const afterConfig = after.runtimeConfig ?? after.config;
  const afterRoute = await projectDefaultInferenceRoute(afterConfig);
  if (
    !sameDefaultInferenceRoute(beforeRoute, afterRoute) ||
    verification.modelRef !== afterRoute.route?.modelLabel
  ) {
    throw new Error(
      "The default-agent inference route changed during setup verification, so setup was not applied. Review the current model/auth/runtime settings and retry.",
    );
  }
  return {
    modelRef: verification.modelRef,
    route: afterRoute,
    latencyMs: verification.latencyMs,
  };
}

export async function executeSetup(
  operation: Extract<SystemAgentOperation, { kind: "setup" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  const overview = await loadOverviewForOperation(opts.deps);
  const defaultModel = overview.defaultModel?.trim();
  if (!defaultModel) {
    throw new Error(
      "OpenClaw setup requires working inference first. Run `openclaw onboard` to configure and verify a default model, then start OpenClaw again.",
    );
  }
  const requestedModel = operation.model?.trim();
  if (requestedModel && requestedModel !== defaultModel) {
    throw new Error(
      `OpenClaw setup will preserve the verified default model ${defaultModel}. Exit OpenClaw and run \`openclaw onboard\` to stage, live-test, and save a different inference route.`,
    );
  }
  if (!opts.approved) {
    const message = [
      formatSystemAgentPersistentPlan(operation),
      `Model choice: keep verified default ${defaultModel}.`,
    ].join("\n");
    runtime.log(message);
    return { applied: false, message };
  }
  const verified = await verifyCurrentSetupInference(runtime, opts.deps);
  if (requestedModel && requestedModel !== verified.modelRef) {
    throw new Error(
      `The verified default model is now ${verified.modelRef}, not ${requestedModel}. Review the current route or exit OpenClaw and run \`openclaw onboard\` before retrying setup.`,
    );
  }
  const workspace = resolveUserPath(operation.workspace ?? process.cwd());
  return await applyPersistentOperation({
    auditOperation: "openclaw.setup",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const applySetup =
        ctx.deps?.applySetup ?? (await import("./setup-apply.js")).applySystemAgentSetup;
      const surface = ctx.deps?.setupSurface ?? "cli";
      // The guarded setup transaction publishes the load-time injected main
      // roster before any workspace provisioning or other follow-up effect.
      // The outer boundary covers injected implementations. The production
      // setup helper also uses this same seam for each of its internal writes.
      const applied = await ctx.commit(
        async () =>
          await applySetup(
            {
              workspace,
              expectedInferenceRoute: verified.route,
              surface,
              runtime: ctx.runtime,
            },
            { commit: async (effect) => await ctx.commit(effect) },
          ),
      );
      const after = await readConfigFileSnapshotLazy();
      ctx.runtime.log(`Updated ${after.path || applied.configPath || "config"}`);
      for (const line of applied.lines) {
        ctx.runtime.log(line);
      }
      ctx.runtime.log(`Default model: ${verified.modelRef} (verified and kept)`);
      return {
        summary: "Bootstrapped setup workspace",
        bootstrapPending: applied.bootstrapPending,
        configPath: after.path || applied.configPath,
        details: {
          workspace,
          model: verified.modelRef,
          modelSource: "live-verified default model",
          inferenceLatencyMs: verified.latencyMs,
        },
      };
    },
  });
}

export async function executeSetDefaultModel(
  operation: Extract<SystemAgentOperation, { kind: "set-default-model" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  return await applyPersistentOperation({
    auditOperation: "config.setDefaultModel",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const { mutateConfigFile, readConfigFileSnapshot } = await loadConfigModule();
      const { applySystemAgentModelSelection, createSystemAgentModelSelectionUpdater } =
        await import("./setup-apply.js");
      const targetAgentId = operation.agentId;
      // Route projection and the live probes below all take the same optional
      // agent scope, so a per-agent selection is verified against that agent's
      // route with the exact rigor the default route gets.
      const projectRoute = (config: OpenClawConfig) => projectInferenceRoute(config, targetAgentId);
      const snapshot = await readConfigFileSnapshot();
      const stagedConfig = await applySystemAgentModelSelection({
        config: snapshot.sourceConfig,
        model: operation.model,
        ...(targetAgentId ? { targetAgentId } : {}),
      });
      const beforeRoute = await projectRoute(snapshot.sourceConfig);
      const verifiedRoute = await projectRoute(stagedConfig);
      const verifyInferenceConfig =
        ctx.deps?.verifyInferenceConfig ??
        (await import("./setup-inference.js")).verifySetupInferenceConfig;
      const initialVerification = await verifyInferenceConfig({
        config: stagedConfig,
        runtime: ctx.runtime,
        requireExecutionOwner: true,
        ...(targetAgentId ? { agentId: targetAgentId } : {}),
      });
      if (!initialVerification.ok) {
        throw new Error(
          `The requested model failed a live inference test, so the current default model was not changed. ${initialVerification.error} Fix provider authentication or model access, then retry.`,
        );
      }
      const verifiedModelRef = verifiedRoute.route?.modelLabel;
      if (!verifiedModelRef || initialVerification.modelRef !== verifiedModelRef) {
        throw new Error(
          "The live inference test did not verify the exact model route that would be saved, so the current default model was not changed. Review model aliases and runtime routing, then retry.",
        );
      }
      let persistedVerification = initialVerification;
      let persistedBinding: SystemAgentVerifiedInferenceBinding | undefined;
      let selectedRouteForCommit = verifiedRoute;
      const selectModel = await createSystemAgentModelSelectionUpdater({
        model: operation.model,
        ...(targetAgentId ? { targetAgentId } : {}),
      });
      const result = await mutateConfigFile({
        base: "source",
        writeOptions: {
          auditOrigin: "system-agent",
          preCommitRuntimePreflight: async (sourceConfig) => {
            const commitRoute = await projectRoute(sourceConfig);
            if (!sameDefaultInferenceRoute(commitRoute, selectedRouteForCommit)) {
              throw new Error(
                "The selected inference route changed while preparing the config write, so the requested model was not saved. Review the current model/auth/runtime settings and retry.",
              );
            }
            await opts.beforePersistentApply?.();
            let latestBinding: SystemAgentVerifiedInferenceBinding | undefined;
            const latestVerification = await verifyInferenceConfig({
              config: sourceConfig,
              runtime: ctx.runtime,
              requireExecutionOwner: true,
              ...(targetAgentId ? { agentId: targetAgentId } : {}),
              ...(opts.onVerifiedInferenceChanged
                ? {
                    onVerifiedExecution: (
                      _auth: AgentExecutionAuthBinding,
                      binding: SystemAgentVerifiedInferenceBinding,
                    ) => {
                      latestBinding = binding;
                    },
                  }
                : {}),
            });
            if (!latestVerification.ok) {
              throw new Error(
                `The requested model no longer passes live inference at the config commit boundary, so it was not saved. ${latestVerification.error} Review concurrent configuration changes and retry.`,
              );
            }
            if (latestVerification.modelRef !== commitRoute.route?.modelLabel) {
              throw new Error(
                "The final live inference test did not verify the exact model route at the config commit boundary, so the requested model was not saved. Review model aliases and runtime routing, then retry.",
              );
            }
            if (opts.onVerifiedInferenceChanged && !latestBinding) {
              throw new Error(
                "The final live inference test did not return a reusable session binding, so the requested model was not saved. Retry the model change.",
              );
            }
            // The live probe can outlive the original OpenClaw authority.
            // Re-check it last, immediately before the writer crosses to disk.
            await opts.beforePersistentApply?.();
            persistedVerification = latestVerification;
            persistedBinding = latestBinding;
          },
        },
        mutate: async (cfg) => {
          // Verification may take time. Preserve unrelated edits, but never
          // combine the passing result with a concurrently changed route.
          const currentRoute = await projectRoute(cfg);
          if (!sameDefaultInferenceRoute(currentRoute, beforeRoute)) {
            throw new Error(
              "The default-agent inference route changed during verification, so the requested model was not saved. Review the current model/auth/runtime settings and retry.",
            );
          }
          const selected = selectModel(cfg);
          const selectedRoute = await projectRoute(selected);
          if (selectedRoute.route?.modelLabel !== verifiedModelRef) {
            throw new Error(
              "The model selection no longer resolves to the exact model that passed live inference. Review the current model/auth/runtime settings and retry.",
            );
          }
          // Unrelated concurrent edits can change how the selected model is
          // represented. Bind the commit gate to this deterministic projection;
          // the final live probe below verifies these exact bytes before write.
          selectedRouteForCommit = selectedRoute;
          cfg.agents = selected.agents;
        },
      });
      if (persistedBinding) {
        opts.onVerifiedInferenceChanged?.(persistedBinding);
      }
      ctx.runtime.log(`Updated ${result.path}`);
      ctx.runtime.log(
        targetAgentId
          ? `Agent ${targetAgentId} model: ${persistedVerification.modelRef}`
          : `Default model: ${persistedVerification.modelRef}`,
      );
      return {
        summary: targetAgentId
          ? `Set agent ${targetAgentId} model to ${operation.model}`
          : `Set default model to ${operation.model}`,
        configPath: result.path,
        details: {
          ...(targetAgentId ? { agentId: targetAgentId } : {}),
          requestedModel: operation.model,
          effectiveModel: persistedVerification.modelRef,
          inferenceVerified: true,
          inferenceLatencyMs: persistedVerification.latencyMs,
        },
      };
    },
  });
}

/**
 * Uninstalling the plugin that provides the active default inference route
 * would break the very session driving the change, so that case stays a
 * terminal-only operation. Every other plugin is uninstallable behind the
 * standard approval gate — matching what the operator can do from the UI/CLI.
 */
export async function isPluginBackingDefaultInferenceRoute(pluginId: string): Promise<boolean> {
  const { readConfigFileSnapshot } = await loadConfigModule();
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return true;
  }
  const config = snapshot.runtimeConfig ?? snapshot.config;
  const route = (await projectDefaultInferenceRoute(config ?? {})).route;
  if (!route) {
    return false;
  }
  // The route's execution owners are the provider plus whichever runtime
  // component executes it (embedded harness override or the resolved model
  // runtime policy, e.g. a CLI-backend harness plugin) — removing any of them
  // breaks the session driving this change.
  const { resolveModelRuntimePolicy } = await import("../agents/model-runtime-policy.js");
  const runtimePolicyId = resolveModelRuntimePolicy({
    config,
    provider: route.provider,
    modelId: route.model,
    agentId: route.agentId,
  }).policy?.id;
  const normalizedPluginId = pluginId.trim().toLowerCase();
  const components = [
    route.provider,
    runtimePolicyId,
    route.runner === "embedded" ? route.agentHarnessRuntimeOverride : undefined,
  ]
    .map((component) => component?.trim().toLowerCase())
    .filter((component): component is string => Boolean(component));
  // Same-name convention covers components with no resolvable plugin metadata.
  if (components.includes(normalizedPluginId)) {
    return true;
  }
  const { resolveOwningPluginIdsForProviderRef } = await import("../plugins/providers.js");
  return components.some((component) =>
    (resolveOwningPluginIdsForProviderRef({ provider: component, config }) ?? []).some(
      (owner) => owner.trim().toLowerCase() === normalizedPluginId,
    ),
  );
}

export async function executePluginInstall(
  operation: Extract<SystemAgentOperation, { kind: "plugin-install" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  // Reject an untrusted plugin source before proposing or installing it, not
  // only on the approved apply — a formatted "plan" must never surface an
  // arbitrary npm/url/file spec that bypassed the ClawHub trust boundary.
  const validationError = validateSystemAgentPluginInstallSpec(operation.spec);
  if (validationError) {
    throw new Error(validationError);
  }
  const result = await applyPersistentOperation({
    auditOperation: "plugin.install",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const runPluginInstall =
        ctx.deps?.runPluginInstall ??
        (async (spec: string, pluginRuntime: RuntimeEnv) => {
          const { runPluginInstallCommand } = await import("../cli/plugins-install-command.js");
          await runPluginInstallCommand({ raw: spec, opts: {}, runtime: pluginRuntime });
        });
      await ctx.commit(async () => {
        await runPluginInstall(operation.spec, createNoExitRuntime(ctx.runtime));
      });
      return { summary: `Installed plugin ${operation.spec}`, details: { spec: operation.spec } };
    },
  });
  if (result.applied) {
    runtime.log("Restart the Gateway to apply installed plugin changes.");
  }
  return result;
}
