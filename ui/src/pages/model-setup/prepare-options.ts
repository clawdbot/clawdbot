import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

export type ModelSetupPrepareOption = {
  id: "ollama" | "llama-cpp";
  brandId?: string;
  label: string;
  hint?: string;
  icon?: string;
  website?: string;
};

export function listModelSetupPrepareOptions(
  result: SystemAgentSetupDetectResult,
): ModelSetupPrepareOption[] {
  const prepareChoices: readonly ModelSetupPrepareOption[] = [
    {
      id: "ollama",
      brandId: "ollama",
      label: t("modelSetup.prepare.ollamaLabel"),
      hint: t("modelSetup.prepare.ollamaHint"),
    },
    {
      id: "llama-cpp",
      brandId: "llama-cpp",
      label: t("modelSetup.prepare.llamaCppLabel"),
      hint: t("modelSetup.prepare.llamaCppHint"),
    },
  ];
  const presented = [
    ...result.manualProviders,
    ...(result.authOptions ?? []),
    ...(result.recommendedInstalls ?? []),
  ];
  return prepareChoices
    .filter(
      (choice) =>
        !result.candidates.some(
          (candidate) =>
            candidate.kind === `provider-auto:${choice.id}` ||
            candidate.modelRef.startsWith(`${choice.id}/`),
        ),
    )
    .map((choice) => {
      const wire = presented.find((entry) => entry.id === choice.id);
      return wire ? Object.assign({}, choice, wire, { id: choice.id }) : choice;
    });
}
