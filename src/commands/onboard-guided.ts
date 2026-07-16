import { formatCliCommand } from "../cli/command-format.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
// Guided onboarding: detect AI access, live-test it, then persist only a working route.
import type {
  ActivateSetupInferenceResult,
  SetupInferenceCandidate,
  SetupInferenceDetection,
  SetupInferenceFailureStatus,
} from "../system-agent/setup-inference.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import { WizardCancelledError, type WizardPrompter } from "../wizard/prompts.js";
import { requireRiskAcknowledgement } from "../wizard/setup.shared.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
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
  ) => Promise<void>;
  createPrompter?: () => WizardPrompter | Promise<WizardPrompter>;
  persistRiskAcknowledgement?: (config: OpenClawConfig) => Promise<void>;
};

type GuidedOnboardingHandoff = { workspace: string };

type CandidateAttempt =
  | { kind: "success"; result: Extract<ActivateSetupInferenceResult, { ok: true }> }
  | { kind: "failure" };

async function openSystemAgentChat(
  deps: GuidedOnboardingDeps,
  workspace: string,
  runtime: RuntimeEnv,
  acceptRisk: boolean,
): Promise<void> {
  const runChat =
    deps.runSystemAgentChat ??
    (async (setupWorkspace: string, chatRuntime: RuntimeEnv, riskAccepted: boolean) => {
      const { runConversationalOnboarding } = await import("./onboard-interactive.js");
      await runConversationalOnboarding(
        {
          workspace: setupWorkspace,
          ...(riskAccepted ? { acceptRisk: true } : {}),
        },
        chatRuntime,
      );
    });
  await runChat(workspace, runtime, acceptRisk);
}

const SETUP_FAILURE_REASON_KEYS: Record<SetupInferenceFailureStatus, string> = {
  auth: "wizard.guided.failureAuth",
  rate_limit: "wizard.guided.failureRateLimit",
  billing: "wizard.guided.failureBilling",
  timeout: "wizard.guided.failureTimeout",
  format: "wizard.guided.failureFormat",
  unavailable: "wizard.guided.failureUnavailable",
  unknown: "wizard.guided.failureUnknown",
};

function setupFailureReason(status: SetupInferenceFailureStatus): string {
  return t(SETUP_FAILURE_REASON_KEYS[status]);
}

async function noteActivationFailure(params: {
  prompter: WizardPrompter;
  label: string;
  result: Extract<ActivateSetupInferenceResult, { ok: false }>;
}): Promise<void> {
  await params.prompter.note(
    t("wizard.guided.testFailure", {
      label: params.label,
      reason: setupFailureReason(params.result.status),
      detail: params.result.error,
    }),
    t("wizard.guided.aiAccessTitle"),
  );
}

async function tryCandidate(params: {
  candidate: SetupInferenceCandidate;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  activate: ActivateSetupInference;
}): Promise<CandidateAttempt> {
  const progress = params.prompter.progress(
    t("wizard.guided.testingCandidate", {
      label: params.candidate.label,
      modelRef: params.candidate.modelRef,
    }),
  );
  const result = await withConsoleSubsystemsSuppressed(() =>
    params.activate({
      kind: params.candidate.kind,
      modelRef: params.candidate.modelRef,
      workspace: params.workspace,
      surface: "cli",
      runtime: params.runtime,
    }),
  );
  progress.stop(result.ok ? t("wizard.guided.testPassed") : t("wizard.guided.testFailed"));
  if (result.ok) {
    return { kind: "success", result };
  }
  await noteActivationFailure({
    prompter: params.prompter,
    label: params.candidate.label,
    result,
  });
  return { kind: "failure" };
}

async function runManualStage(params: {
  detection: SetupInferenceDetection;
  autoAttemptedKinds: ReadonlySet<SetupInferenceCandidate["kind"]>;
  config: OpenClawConfig;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  activate: ActivateSetupInference;
}): Promise<string[] | null> {
  const allowedChoices = new Set([
    ...params.detection.manualProviders.map((provider) => provider.id),
    ...params.detection.authOptions.map((option) => option.id),
  ]);
  const detectedOptions = params.detection.candidates.map((candidate) => ({
    value: `candidate:${candidate.kind}`,
    label: t(
      params.autoAttemptedKinds.has(candidate.kind)
        ? "wizard.guided.retryCandidate"
        : "wizard.guided.tryCandidate",
      {
        label: candidate.label,
        detail: candidate.detail,
      },
    ),
  }));
  if (detectedOptions.length === 0 && allowedChoices.size === 0) {
    await params.prompter.note(
      t("wizard.guided.noInferenceOptions"),
      t("wizard.guided.aiAccessTitle"),
    );
    throw new WizardCancelledError("no inference setup options");
  }
  const additionalGroups: AuthChoiceGroup[] = detectedOptions.length
    ? [
        {
          value: "detected-ai",
          label: t("wizard.guided.detectedTitle"),
          options: detectedOptions,
        },
      ]
    : [];
  const [{ ensureAuthProfileStore }, { promptAuthChoiceGrouped }] = await Promise.all([
    import("../agents/auth-profiles.runtime.js"),
    import("./auth-choice-prompt.js"),
  ]);
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  while (true) {
    const choice = await promptAuthChoiceGrouped({
      prompter: params.prompter,
      store,
      includeSkip: true,
      assistantVisibleOnly: false,
      allowedChoices,
      additionalGroups,
      config: params.config,
      workspaceDir: params.workspace,
    });

    if (choice === "skip") {
      await params.prompter.note(
        t("wizard.guided.nextStepsWithoutAi", { workspace: params.workspace }),
        t("wizard.guided.nextStepsTitle"),
      );
      return null;
    }
    if (choice.startsWith("candidate:")) {
      const kind = choice.slice("candidate:".length);
      const candidate = params.detection.candidates.find((item) => item.kind === kind);
      if (!candidate) {
        continue;
      }
      const attempt = await tryCandidate({
        candidate,
        workspace: params.workspace,
        runtime: params.runtime,
        prompter: params.prompter,
        activate: params.activate,
      });
      if (attempt.kind === "success") {
        return activationLines(attempt.result);
      }
      continue;
    }

    const authOption = params.detection.authOptions.find((item) => item.id === choice);
    if (authOption) {
      const result = await withConsoleSubsystemsSuppressed(() =>
        params.activate({
          kind: "provider-auth",
          authChoice: authOption.id,
          workspace: params.workspace,
          surface: "cli",
          runtime: params.runtime,
          prompter: params.prompter,
        }),
      );
      if (result.ok) {
        return activationLines(result);
      }
      await noteActivationFailure({
        prompter: params.prompter,
        label: authOption.label,
        result,
      });
      continue;
    }

    const provider = params.detection.manualProviders.find((item) => item.id === choice);
    if (!provider) {
      continue;
    }
    const apiKey = await params.prompter.text({
      message: t("wizard.guided.apiKeyPrompt", { label: provider.label }),
      sensitive: true,
      validate: (value) => (value.trim() ? undefined : t("common.required")),
    });
    const progress = params.prompter.progress(
      t("wizard.guided.testingManualProvider", { label: provider.label }),
    );
    const result = await withConsoleSubsystemsSuppressed(() =>
      params.activate({
        kind: "api-key",
        authChoice: provider.id,
        apiKey,
        workspace: params.workspace,
        surface: "cli",
        runtime: params.runtime,
      }),
    );
    progress.stop(result.ok ? t("wizard.guided.testPassed") : t("wizard.guided.testFailed"));
    if (result.ok) {
      return activationLines(result);
    }
    await noteActivationFailure({ prompter: params.prompter, label: provider.label, result });
  }
}

function activationLines(result: Extract<ActivateSetupInferenceResult, { ok: true }>): string[] {
  return [
    ...result.lines,
    t("wizard.guided.repliedIn", { seconds: (result.latencyMs / 1000).toFixed(1) }),
  ];
}

async function persistRiskAcknowledgement(config: OpenClawConfig): Promise<void> {
  const securityAcknowledgedAt = config.wizard?.securityAcknowledgedAt;
  if (!securityAcknowledgedAt) {
    return;
  }
  const { mutateConfigFileWithRetry } = await import("../config/config.js");
  await mutateConfigFileWithRetry({
    mutate: (draft) => {
      if (draft.wizard?.securityAcknowledgedAt) {
        return;
      }
      draft.wizard = { ...draft.wizard, securityAcknowledgedAt };
    },
  });
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
  await prompter.intro(t("wizard.guided.intro"));
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
  const acknowledgedConfig = await requireRiskAcknowledgement({
    opts,
    prompter,
    config: existingConfig,
  });
  if (!existingConfig.wizard?.securityAcknowledgedAt) {
    await (deps.persistRiskAcknowledgement ?? persistRiskAcknowledgement)(acknowledgedConfig);
  }

  // Inference is the only prerequisite for OpenClaw. Use the caller's or
  // current default workspace as isolated probe context; OpenClaw owns any
  // workspace choice and persistence after the live completion succeeds.
  const workspace = resolveUserPath(
    opts.workspace?.trim() ||
      acknowledgedConfig.agents?.defaults?.workspace?.trim() ||
      onboardHelpers.DEFAULT_WORKSPACE,
  );

  const detect =
    deps.detect ?? (await import("../system-agent/setup-inference.js")).detectSetupInference;
  const detectionProgress = prompter.progress(t("wizard.guided.detecting"));
  const detection = await detect();
  detectionProgress.stop(t("wizard.guided.detected"));
  if (detection.candidates.length === 0) {
    await prompter.note(t("wizard.guided.foundNothing"), t("wizard.guided.detectedTitle"));
  } else {
    const candidates = detection.candidates.map((candidate) =>
      t("wizard.guided.detectedCandidate", {
        label: candidate.label,
        detail: candidate.detail,
      }),
    );
    await prompter.note(candidates.join("\n"), t("wizard.guided.detectedTitle"));
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

  const activate =
    deps.activate ?? (await import("../system-agent/setup-inference.js")).activateSetupInference;
  const autoAttemptedKinds = new Set<SetupInferenceCandidate["kind"]>();
  let resultLines: string[] | undefined;
  // Logged-out CLIs stay visible as manual choices, but auto-testing them would
  // only produce predictable auth failures and slow the fallback ladder.
  for (const candidate of detection.candidates.filter((item) => item.credentials !== false)) {
    autoAttemptedKinds.add(candidate.kind);
    const attempt = await tryCandidate({ candidate, workspace, runtime, prompter, activate });
    if (attempt.kind === "success") {
      resultLines = activationLines(attempt.result);
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
  if (!resultLines) {
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
  return { workspace };
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
  if (handoff) {
    // The live completion makes conversational setup safe. Start only after
    // the wizard lifecycle restores stdin so OpenClaw receives a clean TTY.
    await openSystemAgentChat(deps, handoff.workspace, runtime, true);
  }
}
