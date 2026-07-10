import { formatCliCommand } from "../cli/command-format.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
// Guided onboarding: detect AI access, live-test it, then persist only a working route.
import type {
  CrestodianSetupApplyParams,
  CrestodianSetupApplyResult,
} from "../crestodian/setup-apply.js";
import type {
  ActivateSetupInferenceResult,
  SetupInferenceCandidate,
  SetupInferenceDetection,
  SetupInferenceStatus,
} from "../crestodian/setup-inference.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { requireRiskAcknowledgement } from "../wizard/setup.shared.js";
import {
  hasInteractiveOnboardingTty,
  runInteractiveOnboarding,
} from "./onboard-interactive-runner.js";
import type { OnboardOptions } from "./onboard-types.js";

type ActivateSetupInference =
  typeof import("../crestodian/setup-inference.js").activateSetupInference;
type DetectSetupInference = typeof import("../crestodian/setup-inference.js").detectSetupInference;

export type GuidedOnboardingDeps = {
  detect?: DetectSetupInference;
  activate?: ActivateSetupInference;
  runClassicSetup?: (opts: OnboardOptions, runtime: RuntimeEnv) => Promise<void>;
  applySetup?: (params: CrestodianSetupApplyParams) => Promise<CrestodianSetupApplyResult>;
  createPrompter?: () => WizardPrompter | Promise<WizardPrompter>;
  launchTui?: () => Promise<void>;
};

type GuidedSetupResult =
  | { kind: "complete"; lines: string[]; inferenceConfirmed: boolean }
  | { kind: "delegated" };

type CandidateAttempt =
  | { kind: "success"; result: Extract<ActivateSetupInferenceResult, { ok: true }> }
  | { kind: "failure" };

const MANUAL_CLASSIC = "action:classic";
const MANUAL_SKIP = "action:skip";

const SETUP_FAILURE_REASON_KEYS: Record<SetupInferenceStatus, string> = {
  auth: "wizard.guided.failureAuth",
  rate_limit: "wizard.guided.failureRateLimit",
  billing: "wizard.guided.failureBilling",
  timeout: "wizard.guided.failureTimeout",
  format: "wizard.guided.failureFormat",
  unavailable: "wizard.guided.failureUnavailable",
  ok: "wizard.guided.failureUnknown",
  unknown: "wizard.guided.failureUnknown",
};

function setupFailureReason(status: SetupInferenceStatus): string {
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
  opts: OnboardOptions;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  deps: GuidedOnboardingDeps;
  activate: ActivateSetupInference;
}): Promise<GuidedSetupResult> {
  while (true) {
    const choice = await params.prompter.select({
      message: t("wizard.guided.manualChoice"),
      options: [
        ...params.detection.candidates.map((candidate) => ({
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
        })),
        ...params.detection.manualProviders.map((provider) => ({
          value: `manual:${provider.id}`,
          label: t("wizard.guided.enterApiKey", { label: provider.label }),
          ...(provider.hint ? { hint: provider.hint } : {}),
        })),
        {
          value: MANUAL_CLASSIC,
          label: t("wizard.guided.useClassic"),
        },
        {
          value: MANUAL_SKIP,
          label: t("wizard.guided.skipAi"),
        },
      ],
    });

    if (choice === MANUAL_CLASSIC) {
      const runClassic =
        params.deps.runClassicSetup ??
        (async (opts: OnboardOptions, runtime: RuntimeEnv) => {
          const { runInteractiveSetup } = await import("./onboard-interactive.js");
          await runInteractiveSetup(opts, runtime);
        });
      // The classic escape owns its workspace/default handling. The risk
      // acknowledgement was already collected by the guided flow, so pass it
      // through — re-prompting the same session twice reads as a bug.
      await runClassic({ ...params.opts, acceptRisk: true }, params.runtime);
      return { kind: "delegated" };
    }
    if (choice === MANUAL_SKIP) {
      const applySetup =
        params.deps.applySetup ??
        (await import("../crestodian/setup-apply.js")).applyCrestodianSetup;
      const applied = await applySetup({
        workspace: params.workspace,
        surface: "cli",
        runtime: params.runtime,
      });
      await params.prompter.note(t("wizard.guided.skipAiLater"), t("wizard.guided.aiAccessTitle"));
      return {
        kind: "complete",
        lines: applied.lines,
        inferenceConfirmed: false,
      };
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
        return {
          kind: "complete",
          lines: activationLines(attempt.result),
          inferenceConfirmed: true,
        };
      }
      continue;
    }

    const providerId = choice.slice("manual:".length);
    const provider = params.detection.manualProviders.find((item) => item.id === providerId);
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
      return { kind: "complete", lines: activationLines(result), inferenceConfirmed: true };
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

async function runGuidedOnboardingFlow(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  deps: GuidedOnboardingDeps,
): Promise<void> {
  const onboardHelpers = await import("./onboard-helpers.js");
  const prompter = await (deps.createPrompter?.() ??
    import("../wizard/clack-prompter.js").then(({ createClackPrompter }) => createClackPrompter()));
  onboardHelpers.printWizardHeader(runtime);
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
    return;
  }
  const existingConfig =
    snapshot.exists && snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
  await requireRiskAcknowledgement({ opts, prompter, config: existingConfig });

  const initialWorkspace =
    opts.workspace?.trim() ||
    existingConfig.agents?.defaults?.workspace?.trim() ||
    onboardHelpers.DEFAULT_WORKSPACE;
  const workspaceInput = await prompter.text({
    message: t("wizard.guided.workspace"),
    initialValue: initialWorkspace,
  });
  const workspace = resolveUserPath(workspaceInput.trim() || initialWorkspace);

  const detect =
    deps.detect ?? (await import("../crestodian/setup-inference.js")).detectSetupInference;
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

  const activate =
    deps.activate ?? (await import("../crestodian/setup-inference.js")).activateSetupInference;
  const autoAttemptedKinds = new Set<SetupInferenceCandidate["kind"]>();
  let result: GuidedSetupResult | undefined;
  // Logged-out CLIs stay visible as manual choices, but auto-testing them would
  // only produce predictable auth failures and slow the fallback ladder.
  for (const candidate of detection.candidates.filter((item) => item.credentials !== false)) {
    autoAttemptedKinds.add(candidate.kind);
    const attempt = await tryCandidate({ candidate, workspace, runtime, prompter, activate });
    if (attempt.kind === "success") {
      result = {
        kind: "complete",
        lines: activationLines(attempt.result),
        inferenceConfirmed: true,
      };
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
  result ??= await runManualStage({
    detection,
    autoAttemptedKinds,
    opts,
    workspace,
    runtime,
    prompter,
    deps,
    activate,
  });
  if (result.kind === "delegated") {
    return;
  }

  await prompter.note(result.lines.join("\n"), t("wizard.guided.appliedTitle"));
  await prompter.note(
    t(result.inferenceConfirmed ? "wizard.guided.nextSteps" : "wizard.guided.nextStepsWithoutAi", {
      workspace: shortenHomePath(workspace),
    }),
    t("wizard.guided.nextStepsTitle"),
  );
  if (!result.inferenceConfirmed) {
    await prompter.outro(t("wizard.guided.completeWithoutAi"));
    return;
  }
  const openChat = await prompter.confirm({
    message: t("wizard.guided.openChatNow"),
    initialValue: true,
  });
  if (openChat) {
    const launchTui =
      deps.launchTui ??
      (async () => {
        const { launchTuiCli } = await import("../tui/tui-launch.js");
        const { restoreTerminalState } =
          await import("../../packages/terminal-core/src/restore.js");
        // Mirror the classic finalize handoff (setup.finalize.ts): the TUI must
        // not inherit the wizard prompter's raw/paused terminal state.
        restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: false });
        try {
          await launchTuiCli({ deliver: false });
        } finally {
          restoreTerminalState("post-setup tui", { resumeStdinIfPaused: false });
        }
      });
    await launchTui();
    return;
  }
  await prompter.outro(t("wizard.guided.complete"));
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
  await runInteractiveOnboarding(
    async () => await runGuidedOnboardingFlow(opts, runtime, deps),
    runtime,
  );
}
