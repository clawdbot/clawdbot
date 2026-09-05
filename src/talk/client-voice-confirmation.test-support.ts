import "./client-voice-confirmation.js";

type ClientVoiceConfirmationTestApi = {
  resetClientVoiceConfirmationStateForTest(): void;
  snapshotClientVoiceConfirmationStateForTest(): ClientVoiceConfirmationStateSnapshot;
};

export type ClientVoiceConfirmationStateSnapshot = {
  scopeOwners: number;
  pendingChallenges: number;
  recentUtterances: number;
  approvedRuns: number;
  approvedGrants: number;
  expiryOwners: number;
};

function getTestApi(): ClientVoiceConfirmationTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceConfirmationTestApi")
  ] as ClientVoiceConfirmationTestApi;
}

export function resetClientVoiceConfirmationStateForTest(): void {
  getTestApi().resetClientVoiceConfirmationStateForTest();
}

export function snapshotClientVoiceConfirmationStateForTest(): ClientVoiceConfirmationStateSnapshot {
  return getTestApi().snapshotClientVoiceConfirmationStateForTest();
}
