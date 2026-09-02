import type { SystemAgentSetupDetectResult } from "../../api/types.ts";

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
  return (result.prepareOptions ?? []).filter(
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
