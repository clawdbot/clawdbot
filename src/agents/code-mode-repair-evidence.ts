import type { CodeModePrivateAuthority } from "./code-mode-private-authority.js";

const codeModeRepairEvidence = new WeakSet<object>();

export function markCodeModeRepairEvidence(result: object): void {
  codeModeRepairEvidence.add(result);
}

export function hasCodeModeRepairEvidence(result: unknown): boolean {
  return typeof result === "object" && result !== null && codeModeRepairEvidence.has(result);
}

export function sealCodeModeRepairEvidence<
  T extends object & { status?: string; bridgeRequestId?: string },
>(authority: CodeModePrivateAuthority, result: T): T {
  const trustedPreflight =
    result.status === "failed" && authority.consumeTrustedPreflight(result.bridgeRequestId);
  delete result.bridgeRequestId;
  if (trustedPreflight) {
    markCodeModeRepairEvidence(result);
  }
  authority.revoke();
  return result;
}
