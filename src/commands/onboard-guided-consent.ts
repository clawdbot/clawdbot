import type { OpenClawConfig } from "../config/types.openclaw.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { getSecurityNoteTitle } from "../wizard/setup.security-note.js";
import { requestTelemetryConsent, requireRiskAcknowledgement } from "../wizard/setup.shared.js";
import type { OnboardOptions } from "./onboard-types.js";

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

export async function requestGuidedOnboardingConsent(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
  config: OpenClawConfig;
  offerQuickstart: boolean;
  persistRiskAcknowledgement?: (config: OpenClawConfig) => Promise<string | void>;
}): Promise<{ quickstart: boolean; config: OpenClawConfig; securityAcknowledgedAt: string }> {
  const { opts, prompter, config: existingConfig, offerQuickstart } = params;
  let quickstart = false;
  if (offerQuickstart) {
    if (!existingConfig.wizard?.securityAcknowledgedAt) {
      await prompter.note(t("wizard.guided.laneSecurityLine"), getSecurityNoteTitle());
    }
    quickstart =
      (await prompter.select({
        message: t("wizard.guided.laneQuestion"),
        options: [
          {
            value: "quick",
            label: t("wizard.guided.laneQuickLabel"),
            hint: t("wizard.guided.laneQuickHint"),
          },
          {
            value: "custom",
            label: t("wizard.guided.laneCustomLabel"),
            hint: t("wizard.guided.laneCustomHint"),
          },
        ],
        initialValue: "quick",
      })) === "quick";
  }
  let acknowledgedConfig = await requireRiskAcknowledgement({
    // Quick start acknowledges here; Custom keeps the full note and confirmation.
    opts: quickstart ? { ...opts, acceptRisk: true } : opts,
    prompter,
    config: existingConfig,
  });
  if (!quickstart) {
    acknowledgedConfig = await requestTelemetryConsent({
      opts,
      prompter,
      config: acknowledgedConfig,
    });
  }
  let securityAcknowledgedAt = acknowledgedConfig.wizard?.securityAcknowledgedAt;
  if (
    !existingConfig.wizard?.securityAcknowledgedAt ||
    (!existingConfig.telemetry?.consentedAt && acknowledgedConfig.telemetry?.consentedAt)
  ) {
    const persistedAcknowledgement = await (
      params.persistRiskAcknowledgement ?? persistRiskAcknowledgement
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
  return {
    quickstart,
    config: acknowledgedConfig,
    securityAcknowledgedAt: onboardingSecurityAcknowledgedAt,
  };
}
