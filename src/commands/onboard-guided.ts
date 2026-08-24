import { randomUUID } from "node:crypto";
import { formatCliCommand } from "../cli/command-format.js";
import { isUnconfiguredConfigSource } from "../cli/fresh-install-config.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
// Guided onboarding: detect AI access, live-test it, then persist only a working route.
import type {
  SetupInferenceCandidate,
  SetupInferenceDetection,
} from "../system-agent/setup-inference.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { requestTelemetryConsent, requireRiskAcknowledgement } from "../wizard/setup.shared.js";
import type { runBrowserHatchHandoff } from "./onboard-browser-handoff.js";
import { promptFirstOnboardingAgent, showSessionMigrationWarnings } from "./onboard-first-agent.js";
import {
  activationLines,
  formatSetupCandidateFailure,
  runManualStage,
  type SetupCandidateFailure,
  tryCandidate,
} from "./onboard-guided-manual.js";
import {
  hasInteractiveOnboardingTty,
  runInteractiveOnboarding,
} from "./onboard-interactive-runner.js";
import type { OnboardOptions } from "./onboard-types.js";

type ActivateSetupInference =
  typeof import("../system-agent/setup-inference.js").activateSetupInference;
type DetectSetupInference =
  typeof import("../system-agent/setup-inference.js").detectSetupInference;

export type GuidedOnboardingDeps = {
  detect?: DetectSetupInference;
  activate?: ActivateSetupInference;
  runSystemAgentChat?: (
    workspace: string,
    runtime: RuntimeEnv,
    acceptRisk: boolean,
    agentName?: string,
  ) => Promise<void>;
  createPrompter?: () => WizardPrompter | Promise<WizardPrompter>;
  persistRiskAcknowledgement?: (config: OpenClawConfig) => Promise<string | void>;
  persistAccessMode?: (mode: GuidedAccessMode) => Promise<void>;
  listManualOptions?: typeof import("../system-agent/setup-inference.js").listManualSetupInferenceOptions;
  /**
   * "hatch" (default) runs the local custodian flow: question zero, quiet
   * failure collection, deterministic setup apply, then the agent TUI.
   * "chat" preserves the legacy handoff into the OpenClaw system-agent chat —
   * remote-gateway onboarding requires it because setup must apply remotely.
   */
  handoffMode?: "hatch" | "chat";
  applySetup?: typeof import("../system-agent/setup-apply.js").applySystemAgentSetup;
  launchHatchTui?: (workspace: string) => Promise<void>;
  runSetupMemoryImportStep?: typeof import("../wizard/setup.memory-import.js").runSetupMemoryImportStep;
  runAppRecommendations?: typeof import("../wizard/setup.app-recommendations.js").setupAppRecommendations;
  /** Browser-first local hatch handoff. Tests inject this to avoid real browser/Gateway work. */
  runBrowserHandoff?: typeof runBrowserHatchHandoff;
  platform?: NodeJS.Platform;
};

export type GuidedAccessMode = "full" | "guarded";

type GuidedOnboardingHandoff = {
  workspace: string;
  next: "browser" | "hatch" | "chat";
  agentName?: string;
};

async function openSystemAgentChat(
  deps: GuidedOnboardingDeps,
  workspace: string,
  runtime: RuntimeEnv,
  acceptRisk: boolean,
  agentName?: string,
): Promise<void> {
  const runChat =
    deps.runSystemAgentChat ??
    (async (
      setupWorkspace: string,
      chatRuntime: RuntimeEnv,
      riskAccepted: boolean,
      setupAgentName?: string,
    ) => {
      const { runConversationalOnboarding } = await import("./onboard-interactive.js");
      await runConversationalOnboarding(
        {
          workspace: setupWorkspace,
          ...(setupAgentName ? { agentName: setupAgentName } : {}),
          ...(riskAccepted ? { acceptRisk: true } : {}),
        },
        chatRuntime,
      );
    });
  await runChat(workspace, runtime, acceptRisk, agentName);
}

async function persistRiskAcknowledgement(config: OpenClawConfig): Promise<string | undefined> {
  const securityAcknowledgedAt = config.wizard?.securityAcknowledgedAt;
  if (!securityAcknowledgedAt) {
    return undefined;
  }
  const { mutateConfigFileWithRetry } = await import("../config/config.js");
  const committed = await mutateConfigFileWithRetry({
    mutate: (draft) => {
      if (!draft.wizard?.securityAcknowledgedAt) {
        draft.wizard = { ...draft.wizard, securityAcknowledgedAt };
      }
      if (config.telemetry?.consentedAt && !draft.telemetry?.consentedAt) {
        draft.telemetry = config.telemetry;
      }
    },
  });
  return committed.nextConfig.wizard?.securityAcknowledgedAt;
}

async function runGuidedOnboardingFlow(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  deps: GuidedOnboardingDeps,
): Promise<GuidedOnboardingHandoff | null> {
  const onboardHelpers = await import("./onboard-helpers.js");
  const prompter = await (deps.createPrompter?.() ??
    import("../wizard/clack-prompter.js").then(({ createClackPrompter }) => createClackPrompter()));
  await onboardHelpers.printWizardHeader(runtime);
  await prompter.intro(t("wizard.guided.custodianIntro"));
  await prompter.note(t("wizard.guided.escapeHatches"), t("wizard.guided.welcomeTitle"));

  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? formatConfigIssueLines(snapshot.issues, "-").join("\n")
        : t("wizard.guided.invalidConfigUnknown");
    await prompter.note(
      t("wizard.guided.invalidConfigDetails", {
        path: shortenHomePath(snapshot.path),
        issues,
      }),
      t("wizard.setup.invalidConfigTitle"),
    );
    await prompter.outro(
      t("wizard.guided.invalidConfigRepair", {
        fixCommand: formatCliCommand("openclaw doctor --fix"),
        inspectCommand: formatCliCommand("openclaw config validate"),
      }),
    );
    runtime.exit(1);
    return null;
  }
  const existingConfig =
    snapshot.exists && snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const custodianMode = (deps.handoffMode ?? "hatch") === "hatch";
  const localOnboarding = custodianMode
    ? await import("../state/local-onboarding-state.js")
    : undefined;
  // Capture receipt ownership before risk acknowledgement creates the config;
  // otherwise a concurrent fresh run could be mistaken for stale reset state.
  const previousLocalSetup = localOnboarding?.readLocalOnboardingState(snapshot.path);
  let acknowledgedConfig = await requireRiskAcknowledgement({
    opts,
    prompter,
    config: existingConfig,
  });
  acknowledgedConfig = await requestTelemetryConsent({
    opts,
    prompter,
    config: acknowledgedConfig,
  });
  let securityAcknowledgedAt = acknowledgedConfig.wizard?.securityAcknowledgedAt;
  if (
    !existingConfig.wizard?.securityAcknowledgedAt ||
    (!existingConfig.telemetry?.consentedAt && acknowledgedConfig.telemetry?.consentedAt)
  ) {
    const persistedAcknowledgement = await (
      deps.persistRiskAcknowledgement ?? persistRiskAcknowledgement
    )(acknowledgedConfig);
    if (persistedAcknowledgement) {
      securityAcknowledgedAt = persistedAcknowledgement;
      acknowledgedConfig = {
        ...acknowledgedConfig,
        wizard: { ...acknowledgedConfig.wizard, securityAcknowledgedAt },
      };
    }
  }
  const onboardingSecurityAcknowledgedAt = securityAcknowledgedAt;
  if (!onboardingSecurityAcknowledgedAt) {
    throw new Error("Local onboarding requires its persisted security acknowledgement.");
  }
  const hasAuthoredRoster = hasResolvedRosterBeforeMigrations(snapshot);
  const firstAgent = await promptFirstOnboardingAgent(hasAuthoredRoster, opts.agentName, prompter);

  // Reset removes config but keeps SQLite. Only the original, pre-acknowledgement
  // snapshot distinguishes a new installation from an interrupted previous run.
  let localSetup: LocalOnboardingState | undefined = snapshot.exists
    ? localOnboarding?.readLocalOnboardingStateForConfig(snapshot.path, existingConfig)
    : undefined;
  if (previousLocalSetup?.status === "pending" && localSetup === undefined) {
    const currentSnapshot = await readConfigFileSnapshot();
    const currentAcknowledgement = currentSnapshot.valid
      ? (currentSnapshot.sourceConfig ?? currentSnapshot.config).wizard?.securityAcknowledgedAt
      : undefined;
    if (
      currentAcknowledgement === previousLocalSetup.securityAcknowledgedAt ||
      (currentAcknowledgement && currentAcknowledgement !== onboardingSecurityAcknowledgedAt)
    ) {
      throw new Error("Another onboarding run already owns this installation. Retry setup.");
    }
  }
  const replacePreviousSetup =
    !snapshot.exists ||
    (previousLocalSetup?.status === "pending" && localSetup === undefined) ||
    (previousLocalSetup?.status === "completed" && isUnconfiguredConfigSource(existingConfig));
  const resumingSetup = localSetup?.status === "pending";
  if (
    localSetup?.status === "pending" &&
    opts.workspace?.trim() &&
    resolveUserPath(opts.workspace.trim()) !== resolveUserPath(localSetup.workspace)
  ) {
    throw new Error(
      "Another onboarding run owns a different workspace. Retry onboarding with its approved workspace.",
    );
  }
  const assertLocalSetupOwner = (config: OpenClawConfig) => {
    if (
      localSetup?.status === "pending" &&
      localOnboarding?.readLocalOnboardingStateForConfig(snapshot.path, config)?.runId !==
        localSetup.runId
    ) {
      throw new Error("Another onboarding run replaced this setup operation. Retry onboarding.");
    }
  };

  // Question zero: consent to automatic discovery is front-loaded into one
  // choice so the rest of the flow can be silent (full) or ask-first (guarded).
  // Remote-gateway onboarding (chat handoff) discovers on the gateway host and
  // keeps its legacy flow; the local-consent question would be misleading there.
  let accessMode: GuidedAccessMode = "full";
  if (custodianMode) {
    const accessChoice = await prompter.select<string>({
      message: t("wizard.guided.accessQuestion"),
      options: [
        {
          value: "full",
          label: t("wizard.guided.accessFullLabel"),
          hint: t("wizard.guided.accessFullHint"),
        },
        {
          value: "guarded",
          label: t("wizard.guided.accessGuardedLabel"),
          hint: t("wizard.guided.accessGuardedHint"),
        },
      ],
      // Reruns default to the saved preference; accepting the default must
      // never silently downgrade a guarded choice to full discovery.
      initialValue: existingConfig.wizard?.accessMode === "guarded" ? "guarded" : "full",
    });
    accessMode = accessChoice === "guarded" ? "guarded" : "full";
    if (existingConfig.wizard?.accessMode !== accessMode) {
      await (deps.persistAccessMode ?? persistAccessMode)(accessMode);
    }
  }

  // Inference is the only prerequisite for OpenClaw. Use the caller's or
  // current default workspace as isolated probe context; OpenClaw owns any
  // workspace choice and persistence after the live completion succeeds.
  const workspace = resolveUserPath(
    opts.workspace?.trim() ||
      (resumingSetup ? localSetup?.workspace : undefined) ||
      acknowledgedConfig.agents?.defaults?.workspace?.trim() ||
      onboardHelpers.DEFAULT_WORKSPACE,
  );

  const activateInference =
    deps.activate ?? (await import("../system-agent/setup-inference.js")).activateSetupInference;
  const detect =
    deps.detect ?? (await import("../system-agent/setup-inference.js")).detectSetupInference;
  const autoAttemptedKinds = new Set<SetupInferenceCandidate["kind"]>();
  const ladderFailures: SetupCandidateFailure[] = [];
  let detection: SetupInferenceDetection | undefined;
  let resultLines: string[] | undefined;
  let successLabel: string | undefined;
  const activate: ActivateSetupInference = async (params) => {
    if (
      !localOnboarding ||
      (!resumingSetup && (existingConfig.gateway || detection?.setupComplete === true))
    ) {
      return await activateInference(params);
    }
    return await activateInference({
      ...params,
      onCommitStarted: (sourceConfig) => {
        params.onCommitStarted?.(sourceConfig);
        const committedSecurityAcknowledgedAt = sourceConfig.wizard?.securityAcknowledgedAt;
        if (committedSecurityAcknowledgedAt !== onboardingSecurityAcknowledgedAt) {
          throw new Error(
            "The onboarding configuration changed before inference could be saved. Retry onboarding.",
          );
        }
        if (localSetup?.status === "pending") {
          assertLocalSetupOwner(sourceConfig);
          return;
        }
        const runId = randomUUID();
        const claimedSetup = localOnboarding.beginLocalOnboarding({
          configPath: snapshot.path,
          workspace,
          securityAcknowledgedAt: committedSecurityAcknowledgedAt,
          runId,
          ...(replacePreviousSetup
            ? {
                replace: true,
                ...(previousLocalSetup ? { expectedRunId: previousLocalSetup.runId } : {}),
              }
            : {}),
        });
        if (claimedSetup.runId !== runId) {
          throw new Error("Another onboarding run already owns this installation. Retry setup.");
        }
        localSetup = claimedSetup;
      },
    });
  };

  // Guarded mode turns automatic discovery into an explicit ask; declining it
  // routes straight to the manual provider picker without any scanning.
  const wantsDiscovery =
    accessMode === "full" ||
    (await prompter.select<string>({
      message: t("wizard.guided.lookAroundQuestion"),
      options: [
        { value: "look", label: t("wizard.guided.lookAroundYes") },
        { value: "manual", label: t("wizard.guided.lookAroundManual") },
      ],
      initialValue: "look",
    })) !== "manual";

  if (wantsDiscovery) {
    const detectionProgress = prompter.progress(t("wizard.guided.detecting"));
    detection = await detect();
    detectionProgress.stop(t("wizard.guided.detected"));
    if (detection.candidates.length === 0) {
      await prompter.note(t("wizard.guided.foundNothing"), t("wizard.guided.detectedTitle"));
      if (detection.recommendedInstalls.length > 0) {
        const recommendedInstalls = detection.recommendedInstalls.map((install) =>
          t("wizard.guided.recommendedInstall", {
            label: install.label,
            hint: install.hint,
            website: install.website,
          }),
        );
        await prompter.note(
          recommendedInstalls.join("\n"),
          t("wizard.guided.recommendedInstallsTitle"),
        );
      }
    } else {
      const candidates = detection.candidates.map((candidate) =>
        t("wizard.guided.detectedCandidate", {
          label: candidate.label,
          detail: candidate.detail,
          recommended: "",
        }),
      );
      await prompter.note(candidates.join("\n"), t("wizard.guided.detectedTitle"));
      // The quip claims "this machine"; remote detection runs gateway-side.
      const codingAgents = !custodianMode
        ? []
        : detection.candidates
            .filter(
              (candidate) => candidate.kind === "claude-cli" || candidate.kind === "codex-cli",
            )
            .map((candidate) => candidate.label);
      if (codingAgents.length > 0) {
        await prompter.note(
          t("wizard.guided.codingAgentQuip", { labels: codingAgents.join(", ") }),
          t("wizard.guided.detectedTitle"),
        );
      }
    }
    if (detection.unavailableCandidates.length > 0) {
      const unavailable = detection.unavailableCandidates.map((candidate) =>
        t("wizard.guided.unavailableCandidate", {
          label: candidate.label,
          detail: candidate.detail,
          reason: candidate.reason,
        }),
      );
      await prompter.note(unavailable.join("\n"), t("wizard.guided.unavailableTitle"));
    }

    // Logged-out CLIs stay visible as manual choices, but auto-testing them would
    // only produce predictable auth failures and slow the fallback ladder.
    for (const candidate of detection.candidates.filter((item) => item.credentials !== false)) {
      autoAttemptedKinds.add(candidate.kind);
      const attempt = await tryCandidate({
        candidate,
        workspace,
        runtime,
        prompter,
        activate,
        // Legacy chat handoff keeps loud per-candidate failures.
        ...(custodianMode
          ? { collectFailure: (failure: SetupCandidateFailure) => ladderFailures.push(failure) }
          : {}),
      });
      if (attempt.kind === "success") {
        resultLines = activationLines(attempt.result);
        successLabel =
          candidate.kind === "existing-model"
            ? `${candidate.label} (${candidate.modelRef})`
            : candidate.label;
        break;
      }
      // The verification probe runs outside the configured workspace (setup never
      // executes workspace plugins), so a failing current model can be a false
      // negative. Never let the ladder silently replace a configured default —
      // stop and let the user decide in the manual stage.
      if (candidate.kind === "existing-model") {
        await prompter.note(t("wizard.guided.existingModelKept"), t("wizard.guided.aiAccessTitle"));
        break;
      }
    }
  } else {
    // Declined discovery: build the manual picker from config/manifests only.
    const listManualOptions =
      deps.listManualOptions ??
      (await import("../system-agent/setup-inference.js")).listManualSetupInferenceOptions;
    detection = {
      candidates: [],
      unavailableCandidates: [],
      // Install suggestions come from scanning; a declined scan offers none.
      recommendedInstalls: [],
      ...(await listManualOptions()),
    };
  }

  if (resultLines && successLabel && custodianMode) {
    // Announced default with an easy undo: the working route is already
    // persisted; "see other options" reopens the full picker on top of it.
    if (ladderFailures.length > 0) {
      await prompter.note(
        t("wizard.guided.silentFailures", { count: String(ladderFailures.length) }),
        t("wizard.guided.aiAccessTitle"),
      );
    }
    const routeChoice = await prompter.select<string>({
      message: t("wizard.guided.routeConfirm", { label: successLabel }),
      options: [
        { value: "use", label: t("wizard.guided.routeUse", { label: successLabel }) },
        { value: "other", label: t("wizard.guided.routeOther") },
      ],
      initialValue: "use",
    });
    if (routeChoice === "other") {
      // The quiet summary promised the details here; show them before the picker.
      if (ladderFailures.length > 0) {
        await prompter.note(
          [
            t("wizard.guided.failedOptionsIntro"),
            ...ladderFailures.map(formatSetupCandidateFailure),
          ].join("\n"),
          t("wizard.guided.aiAccessTitle"),
        );
      }
      const manualResult = await runManualStage({
        detection,
        autoAttemptedKinds,
        config: existingConfig,
        workspace,
        runtime,
        prompter,
        activate,
        hasActiveRoute: true,
      });
      // Skip keeps the already-persisted working route instead of aborting.
      if (manualResult) {
        resultLines = manualResult;
      }
    }
  } else if (!resultLines) {
    if (ladderFailures.length > 0) {
      const failureLines = ladderFailures.map(formatSetupCandidateFailure);
      await prompter.note(
        [t("wizard.guided.failedOptionsIntro"), ...failureLines].join("\n"),
        t("wizard.guided.aiAccessTitle"),
      );
    }
    const manualResult = await runManualStage({
      detection,
      autoAttemptedKinds,
      config: existingConfig,
      workspace,
      runtime,
      prompter,
      activate,
    });
    if (!manualResult) {
      return null;
    }
    resultLines = manualResult;
  }

  await prompter.note(resultLines.join("\n"), t("wizard.guided.appliedTitle"));
  const persistedSnapshot = await readConfigFileSnapshot();
  let persistedConfig = persistedSnapshot.valid
    ? (persistedSnapshot.sourceConfig ?? persistedSnapshot.config)
    : acknowledgedConfig;
  if (!custodianMode) {
    if (wantsDiscovery) {
      const runMemoryImport =
        deps.runSetupMemoryImportStep ??
        (await import("../wizard/setup.memory-import.js")).runSetupMemoryImportStep;
      await runMemoryImport({ config: persistedConfig, prompter, runtime });
    }
    return { workspace, next: "chat", ...(firstAgent ? { agentName: firstAgent.name } : {}) };
  }

  // Setup apply installs and restarts the machine-level Gateway service.
  // A configured install re-running onboarding is a verification pass — it
  // must never bounce a live gateway as a side effect of accepting defaults.
  // A durable pending receipt proves a previous activation belonged to unfinished
  // onboarding; authored model-only configs without that receipt stay untouched.
  const alreadyConfigured =
    localSetup?.status !== "pending" && Boolean(detection?.setupComplete || existingConfig.gateway);
  const { resolveSetupWorkspaceSelection } = await import("../wizard/setup.workspace.js");
  const workspaceSelection = await resolveSetupWorkspaceSelection({
    baseConfig: existingConfig,
    requestedWorkspaceDir: workspace,
    prompter,
    canConfirmMove: !alreadyConfigured,
  });
  const { allowWorkspaceChange, conflict: workspaceConflict } = workspaceSelection;
  const appliedWorkspace = workspaceSelection.workspaceDir;
  if (
    localSetup?.status === "pending" &&
    resolveUserPath(appliedWorkspace) !== localSetup.workspace
  ) {
    throw new Error(
      "Another onboarding run owns a different workspace. Retry onboarding with its approved workspace.",
    );
  }
  if (alreadyConfigured) {
    await prompter.note(t("wizard.guided.alreadySetUp"), t("wizard.guided.welcomeTitle"));
    if (workspaceConflict) {
      await prompter.note(
        t("wizard.guided.workspaceConflictClassic", {
          command: formatCliCommand("openclaw onboard --classic"),
        }),
        t("wizard.setup.workspaceConflictTitle"),
      );
    }
    if (firstAgent) {
      const { ensureOnboardingAgent } = await import("./onboard-agent.js");
      const created = await ensureOnboardingAgent({
        config: persistedConfig,
        workspace: appliedWorkspace,
        baseConfig: persistedConfig,
        firstAgent,
      });
      persistedConfig = created.config;
      await showSessionMigrationWarnings(prompter, created.sessionMigrationWarnings);
    }
  } else {
    // Announced default: apply the same setup plan the conversational "yes"
    // would, then hand off to the hatch instead of parking in the OpenClaw chat.
    const applyProgress = prompter.progress(t("wizard.guided.settingUp"));
    try {
      if (localSetup?.status === "pending") {
        const ownerSnapshot = await readConfigFileSnapshot();
        if (
          !ownerSnapshot.exists ||
          !ownerSnapshot.valid ||
          resolveUserPath(ownerSnapshot.path) !== localSetup.configPath
        ) {
          throw new Error(
            "Another onboarding run replaced this setup operation. Retry onboarding.",
          );
        }
        assertLocalSetupOwner(ownerSnapshot.sourceConfig ?? ownerSnapshot.config);
      }
      const applySetup =
        deps.applySetup ?? (await import("../system-agent/setup-apply.js")).applySystemAgentSetup;
      const applied = await withConsoleSubsystemsSuppressed(() =>
        applySetup({
          workspace,
          ...(firstAgent ? { firstAgent } : {}),
          ...(allowWorkspaceChange ? { allowWorkspaceChange: true } : {}),
          ...(resumingSetup ? { resume: true } : {}),
          ...(localSetup?.status === "pending"
            ? { assertCommitPreconditions: assertLocalSetupOwner }
            : {}),
          surface: "cli",
          runtime,
        }),
      );
      if (applied.lines.length > 0) {
        await prompter.note(applied.lines.join("\n"), t("wizard.guided.appliedTitle"));
      }
      if (!applied.workspaceReady) {
        throw new Error(
          "The agent workspace could not be prepared. Retry onboarding to finish setup.",
        );
      }
      if (applied.gateway.status === "failed") {
        throw new Error(applied.gateway.error);
      }
      const appliedSnapshot =
        localSetup?.status === "pending"
          ? await (
              await import("../system-agent/setup-recovery.js")
            ).completeLocalSetupRecovery({
              owner: localSetup,
              appliedConfigPath: applied.configPath,
            })
          : await readConfigFileSnapshot();
      if (!appliedSnapshot.valid) {
        throw new Error("Setup wrote an invalid OpenClaw config.");
      }
      persistedConfig = appliedSnapshot.sourceConfig ?? appliedSnapshot.config;
      applyProgress.stop(t("wizard.guided.setupDone"));
    } catch (error) {
      applyProgress.stop(t("wizard.guided.testFailed"));
      await prompter.note(
        t("wizard.guided.applyFailedFallback", {
          detail: error instanceof Error ? error.message : String(error),
        }),
        t("wizard.guided.aiAccessTitle"),
      );
      return { workspace, next: "chat", ...(firstAgent ? { agentName: firstAgent.name } : {}) };
    }
  }
  if (wantsDiscovery) {
    // Import destinations come from the final persisted agent workspace. Importing
    // before setup apply strands memories when first run specifies --workspace.
    const runMemoryImport =
      deps.runSetupMemoryImportStep ??
      (await import("../wizard/setup.memory-import.js")).runSetupMemoryImportStep;
    await runMemoryImport({ config: persistedConfig, prompter, runtime });
    const runAppRecommendations =
      deps.runAppRecommendations ??
      (await import("../wizard/setup.app-recommendations.js")).setupAppRecommendations;
    const recommendationOutcome = await runAppRecommendations({
      config: persistedConfig,
      prompter,
      runtime,
      workspaceDir: workspace,
      modelRouteVerified: true,
    });
    const recommendedConfig = recommendationOutcome.config;
    if (recommendedConfig !== persistedConfig) {
      const { writeWizardConfigFile } = await import("../wizard/setup.shared.js");
      persistedConfig = await writeWizardConfigFile(recommendedConfig, {
        allowConfigSizeDrop: false,
        mergeBase: persistedConfig,
      });
    }
    recommendationOutcome.commitResult();
  }
  const hatchWorkspace = alreadyConfigured
    ? resolveUserPath(
        existingConfig.agents?.defaults?.workspace?.trim() || onboardHelpers.DEFAULT_WORKSPACE,
      )
    : appliedWorkspace;
  if (opts.skipUi === true) {
    await prompter.outro(t("wizard.guided.complete"));
    return null;
  }
  if (opts.tui !== true) {
    const runBrowserHandoff =
      deps.runBrowserHandoff ??
      (await import("./onboard-browser-handoff.js")).runBrowserHatchHandoff;
    const handoff = await runBrowserHandoff({
      config: persistedConfig,
      prompter,
      ...(opts.suppressGatewayTokenOutput ? { suppressTokenOutput: true } : {}),
    });
    if (handoff.handedOff) {
      await prompter.outro(t("wizard.guided.browserHandoffReady"));
      return { workspace: hatchWorkspace, next: "browser" };
    }
  }
  await prompter.note(t("wizard.guided.findMeLater"), t("wizard.guided.welcomeTitle"));
  await prompter.outro(t("wizard.guided.hatchingNow"));
  // The TUI opens the configured default agent/workspace; on a configured
  // rerun that is the persisted default, not the --workspace probe context.
  return { workspace: hatchWorkspace, next: "hatch" };
}

async function persistAccessMode(mode: GuidedAccessMode): Promise<void> {
  const { mutateConfigFileWithRetry } = await import("../config/config.js");
  await mutateConfigFileWithRetry({
    mutate: (draft) => {
      if (draft.wizard?.accessMode === mode) {
        return;
      }
      draft.wizard = { ...draft.wizard, accessMode: mode };
    },
  });
}

async function launchHatchTui(workspace: string): Promise<void> {
  const [{ launchTuiCli }, { DEFAULT_BOOTSTRAP_FILENAME }, { restoreTerminalState }, fs, path] =
    await Promise.all([
      import("../tui/tui-launch.js"),
      import("../agents/workspace.js"),
      import("../../packages/terminal-core/src/restore.js"),
      import("node:fs"),
      import("node:path"),
    ]);
  const hasBootstrap = fs.existsSync(path.join(workspace, DEFAULT_BOOTSTRAP_FILENAME));
  restoreTerminalState("guided hatch tui", { resumeStdinIfPaused: false });
  try {
    // No timeoutMs: the run-level TUI timeout overrides the configured agent
    // timeout for every turn in the session, not just the hatch message.
    await launchTuiCli({
      local: true,
      deliver: false,
      // Seed the first-run hatch only when the workspace bootstrap exists;
      // re-runs against an established agent open a plain chat instead.
      ...(hasBootstrap ? { message: t("wizard.finalize.bootstrapHatchMessage") } : {}),
    });
  } finally {
    restoreTerminalState("post guided hatch tui", { resumeStdinIfPaused: false });
  }
}

export async function runGuidedOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  deps: GuidedOnboardingDeps = {},
): Promise<void> {
  if (!hasInteractiveOnboardingTty()) {
    runtime.error(t("wizard.guided.ttyRequired"));
    runtime.exit(1);
    return;
  }
  const state: { handoff: GuidedOnboardingHandoff | null } = { handoff: null };
  await runInteractiveOnboarding(async () => {
    state.handoff = await runGuidedOnboardingFlow(opts, runtime, deps);
  }, runtime);
  const handoff = state.handoff;
  if (!handoff) {
    return;
  }
  // Interactive surfaces start only after the wizard lifecycle restores stdin
  // so the TUI (or recovery chat) receives a clean TTY.
  if (handoff.next === "hatch") {
    await (deps.launchHatchTui ?? launchHatchTui)(handoff.workspace);
    return;
  }
  if (handoff.next === "browser") {
    return;
  }
  // Chat handoff: legacy remote-gateway flow, or local recovery after a
  // failed setup apply — the conversational chat can finish interactively.
  await openSystemAgentChat(deps, handoff.workspace, runtime, true, handoff.agentName);
}
