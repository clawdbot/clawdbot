import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  ActivateSetupInferenceResult,
  SetupInferenceCandidate,
  SetupInferenceDetection,
  SetupInferenceFailureStatus,
} from "../system-agent/setup-inference.js";
import { t } from "../wizard/i18n/index.js";
import { WizardCancelledError, type WizardPrompter } from "../wizard/prompts.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";

type ActivateSetupInference =
  typeof import("../system-agent/setup-inference.js").activateSetupInference;

type LadderFailure = { label: string; status: SetupInferenceFailureStatus };

type CandidateAttempt =
  | { kind: "success"; result: Extract<ActivateSetupInferenceResult, { ok: true }> }
  | { kind: "failure" };

const SETUP_FAILURE_REASON_KEYS: Record<SetupInferenceFailureStatus, string> = {
  auth: "wizard.guided.failureAuth",
  rate_limit: "wizard.guided.failureRateLimit",
  billing: "wizard.guided.failureBilling",
  timeout: "wizard.guided.failureTimeout",
  format: "wizard.guided.failureFormat",
  unavailable: "wizard.guided.failureUnavailable",
  unknown: "wizard.guided.failureUnknown",
};

export function setupFailureReason(status: SetupInferenceFailureStatus): string {
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

export async function tryCandidate(params: {
  candidate: SetupInferenceCandidate;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  activate: ActivateSetupInference;
  /** Auto-ladder failures collect into one quiet summary; manual retries stay loud. */
  collectFailure?: (failure: LadderFailure) => void;
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
  if (params.collectFailure) {
    params.collectFailure({ label: params.candidate.label, status: result.status });
  } else {
    await noteActivationFailure({
      prompter: params.prompter,
      label: params.candidate.label,
      result,
    });
  }
  return { kind: "failure" };
}

export async function runManualStage(params: {
  detection: SetupInferenceDetection;
  autoAttemptedKinds: ReadonlySet<SetupInferenceCandidate["kind"]>;
  config: OpenClawConfig;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  activate: ActivateSetupInference;
  /** A working route is already persisted; skipping keeps it instead of exiting AI-less. */
  hasActiveRoute?: boolean;
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
          label: t("wizard.guided.detectedGroupLabel"),
          hint: params.detection.candidates.map((candidate) => candidate.label).join(", "),
          methodMessage: t("wizard.guided.detectedGroupPrompt"),
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
      if (params.hasActiveRoute) {
        await params.prompter.note(
          t("wizard.guided.keepingCurrent"),
          t("wizard.guided.aiAccessTitle"),
        );
        return null;
      }
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

export function activationLines(
  result: Extract<ActivateSetupInferenceResult, { ok: true }>,
): string[] {
  return [
    ...result.lines,
    t("wizard.guided.repliedIn", { seconds: (result.latencyMs / 1000).toFixed(1) }),
  ];
}
