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
import type { WizardPrompter } from "../wizard/prompts.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";

type ActivateSetupInference =
  typeof import("../system-agent/setup-inference.js").activateSetupInference;

const SETUP_FAILURE_REASON_KEYS: Record<SetupInferenceFailureStatus, string> = {
  auth: "wizard.guided.failureAuth",
  rate_limit: "wizard.guided.failureRateLimit",
  billing: "wizard.guided.failureBilling",
  timeout: "wizard.guided.failureTimeout",
  format: "wizard.guided.failureFormat",
  unavailable: "wizard.guided.failureUnavailable",
  unknown: "wizard.guided.failureUnknown",
};

async function noteActivationFailure(params: {
  prompter: WizardPrompter;
  label: string;
  result: Extract<ActivateSetupInferenceResult, { ok: false }>;
}): Promise<void> {
  await params.prompter.note(
    t("wizard.guided.testFailure", {
      label: params.label,
      reason: t(SETUP_FAILURE_REASON_KEYS[params.result.status]),
      detail: params.result.error,
    }),
    t("wizard.guided.aiAccessTitle"),
  );
}

export async function runManualStage(params: {
  detection: SetupInferenceDetection;
  config: OpenClawConfig;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  activate: ActivateSetupInference;
}): Promise<string[] | null> {
  const detectedOptions = params.detection.candidates.map((candidate) => ({
    value: `candidate:${candidate.kind}`,
    label: t("wizard.guided.tryCandidate", {
      label: candidate.label,
      detail: candidate.detail,
    }),
  }));
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
  const { promptAuthChoiceGrouped } = await import("./auth-choice-prompt.js");
  while (true) {
    const choice = await promptAuthChoiceGrouped({
      prompter: params.prompter,
      includeSkip: true,
      assistantVisibleOnly: false,
      additionalGroups,
      config: params.config,
      workspaceDir: params.workspace,
    });

    if (choice === "skip") {
      return null;
    }
    let candidate: SetupInferenceCandidate | undefined;
    if (choice.startsWith("candidate:")) {
      const kind = choice.slice("candidate:".length);
      candidate = params.detection.candidates.find((item) => item.kind === kind);
      if (!candidate) {
        continue;
      }
    }

    const result = await withConsoleSubsystemsSuppressed(() =>
      params.activate({
        kind: candidate?.kind ?? "provider-auth",
        ...(candidate ? { modelRef: candidate.modelRef } : { authChoice: choice }),
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
      label: candidate?.label ?? choice,
      result,
    });
    if (candidate?.kind === "existing-model") {
      await params.prompter.note(
        t("wizard.guided.existingModelKept"),
        t("wizard.guided.aiAccessTitle"),
      );
    }
  }
}

function activationLines(result: Extract<ActivateSetupInferenceResult, { ok: true }>): string[] {
  return [
    ...result.lines,
    t("wizard.guided.repliedIn", { seconds: (result.latencyMs / 1000).toFixed(1) }),
  ];
}
