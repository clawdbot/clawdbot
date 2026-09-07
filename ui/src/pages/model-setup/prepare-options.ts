import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

export type ModelSetupPrepareOption = {
  id: string;
  brandId?: string;
  label: string;
  hint?: string;
  actionLabel?: string;
  icon?: string;
  website?: string;
};

export function providerAutoSetupKind(choiceId: string): `provider-auto:${string}` {
  return `provider-auto:${encodeURIComponent(choiceId)}`;
}

export function listModelSetupPrepareOptions(
  result: SystemAgentSetupDetectResult,
): ModelSetupPrepareOption[] {
  // Released Gateways do not send prepareOptions. Keep their two existing
  // choices until the connected Gateway can advertise provider-owned rows.
  const legacyPrepareChoices: readonly ModelSetupPrepareOption[] = [
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
    },
  ];
  return (result.prepareOptions ?? legacyPrepareChoices).filter(
    (choice) =>
      !result.candidates.some(
        (candidate) =>
          candidate.credentials !== false &&
          (candidate.kind === providerAutoSetupKind(choice.id) ||
            candidate.modelRef.startsWith(`${choice.brandId ?? choice.id}/`)),
      ),
  );
}

export function findPreparedModelCandidate(result: SystemAgentSetupDetectResult, choiceId: string) {
  // Detection deliberately encodes the provider-auth choice ID in the kind;
  // brandId owns the model-ref namespace and may differ.
  return result.candidates.find(
    (candidate) =>
      candidate.kind === providerAutoSetupKind(choiceId) && candidate.credentials !== false,
  );
}
