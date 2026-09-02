/** Applies exec-ref resolution policy for audit/apply modes. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { formatExecSecretRefIdValidationMessage, isValidExecSecretRefId } from "./ref-contract.js";

/**
 * Splits refs by whether the current audit/apply mode is allowed to execute secret providers.
 */
export function selectRefsForExecPolicy(params: { refs: SecretRef[]; allowExec: boolean }): {
  refsToResolve: SecretRef[];
  skippedExecRefs: SecretRef[];
} {
  const refsToResolve: SecretRef[] = [];
  const skippedExecRefs: SecretRef[] = [];
  for (const ref of params.refs) {
    if (ref.source === "exec" && !params.allowExec) {
      // Dry-run preflight can still report static exec-ref problems without invoking commands.
      skippedExecRefs.push(ref);
      continue;
    }
    refsToResolve.push(ref);
  }
  return { refsToResolve, skippedExecRefs };
}

/**
 * Returns static validation errors for skipped exec refs without resolving the provider command.
 */
export function getSkippedExecRefStaticError(params: {
  ref: SecretRef;
  config: OpenClawConfig;
}): string | null {
  const id = params.ref.id.trim();
  const refLabel = `${params.ref.source}:${params.ref.provider}:${id}`;
  if (!id) {
    return "Error: Secret reference id is empty.";
  }
  if (!isValidExecSecretRefId(id)) {
    return `Error: ${formatExecSecretRefIdValidationMessage()} (ref: ${refLabel}).`;
  }
  const providerConfig = params.config.secrets?.providers?.[params.ref.provider];
  if (!providerConfig) {
    return `Error: Secret provider "${params.ref.provider}" is not configured (ref: ${refLabel}).`;
  }
  if (providerConfig.source !== params.ref.source) {
    return `Error: Secret provider "${params.ref.provider}" has source "${providerConfig.source}" but ref requests "${params.ref.source}".`;
  }
  return null;
}
