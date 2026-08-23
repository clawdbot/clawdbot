// Applies OpenClaw's conversational setup: config, workspace files, gateway.
import { isDeepStrictEqual } from "node:util";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import { resolveSystemAgentOnboardingTarget as resolveSystemTarget } from "../commands/onboard-agent-target.js";
import type { FirstOnboardingAgent } from "../commands/onboard-agent.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  resolveConfigSnapshotHash,
  resolveGatewayPort,
  validateConfigObjectWithPlugins,
} from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatExternalSupervisorActionRequired } from "../infra/gateway-supervision.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { GatewayServiceSetupOutcome } from "../wizard/setup.finalize.js";
import {
  projectDefaultInferenceRoute,
  type DefaultInferenceRouteProjection,
} from "./inference-route.js";
import { requireValidSystemAgentSetupSnapshot } from "./setup-config-snapshot.js";
import {
  assertSetupTarget,
  sameSetupConfiguredRoute,
  sameSetupInferenceRoute,
} from "./setup-inference-route-guard.js";
import { applySystemAgentModelSelection } from "./setup-model-selection.js";

/**
 * The whole first-run setup as one approved operation: the user says "yes" in
 * the conversation and this applies model + workspace + quickstart gateway
 * defaults, seeds workspace bootstrap files, and (on the CLI surface) installs
 * and starts the gateway service. No interactive prompts may occur here —
 * everything uses quickstart defaults, so the conversation stays the only UI.
 */
export type SystemAgentSetupApplyParams = {
  workspace: string;
  /** Selected first agent when setup starts without a persisted roster. */
  firstAgent?: FirstOnboardingAgent;
  /** Explicit interactive approval to replace an existing fleet workspace root. */
  allowWorkspaceChange?: boolean;
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
  /** Synchronous cross-store guard receives authored config under the final write lock. */
  assertCommitPreconditions?: (sourceConfig: OpenClawConfig) => void;
  /** Resume an interrupted local installation without restarting a running Gateway. */
  resume?: boolean;
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
};

export type SystemAgentSetupApplyResult = {
  configPath: string;
  configHashBefore: string | null;
  configHashAfter: string | null;
  bootstrapPending: boolean;
  workspaceReady: boolean;
  gateway: GatewayServiceSetupOutcome;
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
    { applyLocalSetupWorkspaceConfig, resolveOnboardingWorkspaceConflict },
    { transformConfigWithPendingPluginInstalls },
  ] = await Promise.all([
    import("../wizard/setup.shared.js"),
    import("../commands/onboard-helpers.js"),
    import("../commands/onboard-config.js"),
    import("../plugins/install-record-commit.js"),
  ]);

  let snapshot = await readSetupConfigFileSnapshot();
  let snapshotConfig = requireValidSystemAgentSetupSnapshot(snapshot);
  const configHashBefore = resolveConfigSnapshotHash(snapshot);
  const startedWithoutAuthoredRoster = !hasResolvedRosterBeforeMigrations(snapshot);
  let verifiedRoute = params.expectedInferenceRoute;
  let guardedExpectedAgentId = expectedAgentId;
  let guardedExpectedAgentDir = expectedAgentDir;
  let sessionMigrationWarnings: string[] = [];

  if (hasExpectedConfigHash && resolveConfigSnapshotHash(snapshot) !== expectedConfigHash) {
    throw new Error("OpenClaw config changed while AI access was being tested. Try setup again.");
  }

  let guardModules =
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
    assertSetupTarget({
      config,
      expectedAgentId: guardedExpectedAgentId,
      expectedAgentDir: guardedExpectedAgentDir,
      expectedModelRef,
      resolveAgentDir: guardModules[0].resolveAgentDir,
      resolveDefaultAgentId: (currentConfig) => resolveSystemTarget(currentConfig).agentId,
      resolveDefaultModelForAgent: guardModules[1].resolveDefaultModelForAgent,
    });
  };
  assertExpectedTarget(snapshotConfig.runtimeConfig);

  const assertVerifiedRoute = async (
    setupSnapshot: ConfigFileSnapshot,
    expectedRoute = verifiedRoute,
    phase: "before" | "after" = "before",
    ignoreAgentIdentity = false,
  ) => {
    if (!expectedRoute) {
      return undefined;
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
    if (
      !currentRoute ||
      !sameSetupInferenceRoute(currentRoute, expectedRoute, ignoreAgentIdentity)
    ) {
      throw new Error(
        phase === "before"
          ? "The default-agent inference route changed before setup could start, so no workspace or Gateway settings were changed. Retry setup from the current OpenClaw session."
          : "The default-agent inference route changed after the config write, so no further setup effects were applied. Retry setup from the current OpenClaw session.",
      );
    }
    return currentRoute;
  };
  await assertVerifiedRoute(snapshot);

  let expectedWriteHash = expectedConfigHash;
  if (startedWithoutAuthoredRoster) {
    const { ensureOnboardingAgent } = await import("../commands/onboard-agent.js");
    const onboardingSourceConfig =
      snapshot.sourceConfigBeforeMigrations ?? snapshotConfig.sourceConfig;
    const created = await commit(
      async () =>
        await ensureOnboardingAgent({
          config: onboardingSourceConfig,
          workspace,
          baseConfig: onboardingSourceConfig,
          firstAgent: params.firstAgent ?? { name: "main" },
          expectedConfigHash: configHashBefore ?? null,
        }),
    );
    if (!created.createdAgent || !created.configHash) {
      throw new Error(
        "OpenClaw did not create the approved first agent because the roster changed. Retry setup.",
      );
    }
    snapshot = await readSetupConfigFileSnapshot();
    snapshotConfig = requireValidSystemAgentSetupSnapshot(snapshot);
    if ((resolveConfigSnapshotHash(snapshot) ?? null) !== created.configHash) {
      throw new Error("OpenClaw config changed after first-agent creation. Retry setup.");
    }
    const createdRoster = listAgentEntries(snapshotConfig.sourceConfig);
    if (
      createdRoster.length !== 1 ||
      normalizeAgentId(createdRoster[0]?.id ?? "") !== created.agentId
    ) {
      throw new Error("OpenClaw first-agent ownership changed during setup. Retry setup.");
    }
    const rebasedRoute = await assertVerifiedRoute(snapshot, verifiedRoute, "before", true);
    verifiedRoute = rebasedRoute ?? verifiedRoute;
    guardModules ??= await Promise.all([
      import("../agents/agent-scope.js"),
      import("../agents/model-selection.js"),
    ] as const);
    guardedExpectedAgentId = created.agentId;
    guardedExpectedAgentDir = guardModules[0].resolveAgentDir(
      snapshotConfig.runtimeConfig,
      created.agentId,
    );
    assertExpectedTarget(snapshotConfig.runtimeConfig);
    expectedWriteHash = created.configHash;
    sessionMigrationWarnings = created.sessionMigrationWarnings ?? [];
  }

  const prompter = createQuickstartNotePrompter(runtime);
  const { configureGatewayForSetup } = await import("../wizard/setup.gateway-config.js");
  const buildSetupCandidate = async (
    currentBaseConfig: OpenClawConfig,
    hasAuthoredRosterEntries: boolean,
  ) => {
    const roster = listAgentEntries(currentBaseConfig);
    // Load-time injection and migration may decorate the synthesized main entry.
    // Authored roster provenance, never the resulting entry shape, establishes a fleet.
    const isBootstrapRoster = !hasAuthoredRosterEntries;
    const workspaceConflict = isBootstrapRoster
      ? undefined
      : resolveOnboardingWorkspaceConflict(currentBaseConfig, workspace);
    const currentHasRoster = hasAuthoredRosterEntries && roster.length > 0;
    const allowWorkspaceWrite =
      params.allowWorkspaceChange || (!workspaceConflict && !currentHasRoster);
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
    if (currentHasRoster) {
      const { list: _legacyList, ...agents } = setupBaseConfig.agents ?? {};
      setupBaseConfig = {
        ...setupBaseConfig,
        agents: {
          ...agents,
          entries: toAgentEntriesRecord(roster),
        },
      };
    }
    const preserveWorkspace =
      (currentHasRoster || Boolean(workspaceConflict)) && !params.allowWorkspaceChange;
    if (preserveWorkspace) {
      const defaults = { ...setupBaseConfig.agents?.defaults };
      const currentDefaults = currentBaseConfig.agents?.defaults;
      if (currentDefaults && Object.hasOwn(currentDefaults, "workspace")) {
        defaults.workspace = currentDefaults.workspace;
      } else {
        delete defaults.workspace;
      }
      setupBaseConfig = {
        ...setupBaseConfig,
        agents: { ...setupBaseConfig.agents, defaults },
      };
    }

    let candidate = applyLocalSetupWorkspaceConfig(setupBaseConfig, workspace, {
      allowWorkspaceChange: allowWorkspaceWrite,
      preserveWorkspace,
    });
    if (model) {
      const targetAgentId = candidate.agents?.defaults?.systemAgent?.agentId;
      candidate = await applySystemAgentModelSelection({
        config: candidate,
        model,
        ...(targetAgentId ? { targetAgentId } : {}),
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
        writeOptions: { auditOrigin: "system-agent", allowConfigSizeDrop: false },
        transform: async (currentConfig, context) => {
          const currentSnapshot = requireValidSystemAgentSetupSnapshot(context.snapshot);
          if (
            (hasExpectedConfigHash || startedWithoutAuthoredRoster) &&
            context.previousHash !== expectedWriteHash
          ) {
            throw new Error(
              "OpenClaw config changed while AI access was being tested. Try setup again.",
            );
          }
          await assertVerifiedRoute(context.snapshot);
          assertExpectedTarget(currentSnapshot.runtimeConfig);

          // Rebuild config and Gateway settings from the same locked snapshot.
          // A retry can preserve unrelated concurrent edits without carrying
          // stale settings from the losing attempt into service setup or probes.
          const setupCandidate = await buildSetupCandidate(
            currentConfig,
            startedWithoutAuthoredRoster
              ? false
              : hasResolvedRosterBeforeMigrations(context.snapshot),
          );
          const finalizedConfig = finalizeConfig
            ? finalizeConfig(setupCandidate.nextConfig, currentSnapshot.sourceConfig)
            : setupCandidate.nextConfig;
          const expectedSourceRoute = verifiedRoute
            ? await projectDefaultInferenceRoute(finalizedConfig)
            : undefined;
          if (
            verifiedRoute &&
            (!verifiedRoute.route ||
              !expectedSourceRoute?.route ||
              !sameSetupConfiguredRoute(expectedSourceRoute.route, verifiedRoute.route, false))
          ) {
            throw new Error(
              "The setup candidate no longer preserves the exact verified inference route, so it was not saved. Retry setup from the current OpenClaw session.",
            );
          }
          // This is the auth/config operation's linearization point. Never hold
          // the synchronous cross-store guard across async config I/O.
          if (assertCommitPreconditions) {
            assertCommitPreconditions(currentSnapshot.sourceConfig);
            if (
              resolveUserPath(resolveSystemTarget(finalizedConfig).workspaceDir) !==
              resolveUserPath(workspace)
            ) {
              throw new Error(
                "Another onboarding run owns a different workspace. Retry onboarding with its approved workspace.",
              );
            }
          }
          return {
            nextConfig: finalizedConfig,
            result: {
              settings: setupCandidate.settings,
            },
          };
        },
      }),
  );
  const nextConfig = committed.nextConfig;
  const setupResult = committed.result;
  const settings = setupResult?.settings;
  if (!settings) {
    throw new Error("OpenClaw setup committed without resolved Gateway settings.");
  }
  const onboardingTarget = resolveSystemTarget(nextConfig);
  const effectiveWorkspace = onboardingTarget.workspaceDir;
  if (verifiedRoute) {
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
    if (!sameSetupConfiguredRoute(expectedPersistedRoute.route, verifiedRoute.route, false)) {
      throw new Error(
        "The materialized inference route no longer matches the exact verified route, so no further setup effects were applied. Retry setup from the current OpenClaw session.",
      );
    }
  }

  const lines: string[] = [
    ...sessionMigrationWarnings,
    `Workspace: ${shortenHomePath(effectiveWorkspace)}`,
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

  const effectiveAgentId = onboardingTarget.agentId;
  const workspaceResult = await runCommittedFollowUp(
    async () =>
      await onboardHelpers.ensureWorkspaceAndSessions(effectiveWorkspace, runtime, {
        agentId: effectiveAgentId,
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
          workspaceDir: onboardingTarget.workspaceDir,
          traceCommand: "openclaw-setup",
          logger: {
            warn: (message) => lines.push(message),
          },
        });
      },
      (error) => lines.push(`Plugin registry refresh failed: ${formatErrorMessage(error)}`),
    );
  }

  let gateway: GatewayServiceSetupOutcome = { status: "ready", action: "reused" };
  if (surface === "cli") {
    // The gateway daemon runs outside this process; install/start it so
    // channels and apps have a live gateway. Inside the gateway process
    // (macOS app chat) the app owns the service lifecycle.
    await runCommittedFollowUp(
      async () => {
        const { ensureGatewayServiceForOnboarding } = await import("../wizard/setup.finalize.js");
        const serviceSetup = await ensureGatewayServiceForOnboarding({
          flow: "quickstart",
          opts: {},
          nextConfig,
          settings,
          prompter,
          runtime,
          loadedAction: params.resume ? "resume" : "restart",
        });
        gateway = serviceSetup.gateway;
        if (gateway.status === "failed") {
          lines.push(`Gateway service: ${gateway.error}`);
        } else if (gateway.status === "ready") {
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
            password:
              settings.authMode === "password"
                ? await (
                    await import("../wizard/setup.secret-input.js")
                  ).resolveSetupSecretInputString({
                    config: nextConfig,
                    value: nextConfig.gateway?.auth?.password,
                    path: "gateway.auth.password",
                    env: process.env,
                  })
                : undefined,
            deadlineMs: 15_000,
          });
          if (probe.ok) {
            lines.push(`Gateway: running at ${probeLinks.wsUrl}`);
          } else {
            const detail = probe.detail ?? "still starting";
            gateway = { status: "failed", error: `Gateway is not reachable yet (${detail}).` };
            lines.push(`Gateway: not reachable yet (${detail}) — say \`gateway status\` to check`);
          }
        } else if (gateway.reason === "external") {
          lines.push(`Gateway: ${formatExternalSupervisorActionRequired("start the gateway")}`);
        } else {
          lines.push(
            "Gateway: service install skipped — say `start gateway` when you want it running.",
          );
        }
      },
      (error) => {
        const message = formatErrorMessage(error);
        gateway = { status: "failed", error: message };
        lines.push(`Gateway service: ${message}`);
      },
    );
  } else {
    lines.push("Gateway: running (managed by this app).");
  }

  return {
    configPath: committed.path,
    configHashBefore,
    configHashAfter: committed.persistedHash,
    bootstrapPending: workspaceResult?.bootstrapPending === true,
    workspaceReady: workspaceResult !== undefined,
    gateway,
    lines,
  };
}
