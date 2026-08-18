import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { isSecretRef, resolveSecretInputRef, type SecretRef } from "../config/types.secrets.js";
import { shouldAuditPlaintextMcpValue } from "./mcp-target-sensitivity.js";
import { isLikelySensitiveModelProviderHeaderName } from "./model-provider-header-policy.js";
import { hasConfiguredPlaintextSecretValue } from "./secret-value.js";
import type { DiscoveredConfigSecretTarget } from "./target-registry.js";

type SecretDefaults = { env?: string; file?: string; exec?: string };

export function evaluateConfigTargetAuditPolicy(params: {
  target: DiscoveredConfigSecretTarget;
  defaults: SecretDefaults | undefined;
}): { ref: SecretRef | undefined; hasPlaintext: boolean; skipPlaintext: boolean } {
  const { target } = params;
  const isMcpTarget =
    target.entry.id === "mcp.servers.*.env.*" || target.entry.id === "mcp.servers.*.headers.*";
  const ref = isMcpTarget
    ? isSecretRef(target.value)
      ? target.value
      : undefined
    : (resolveSecretInputRef({
        value: target.value,
        refValue: target.refValue,
        defaults: params.defaults,
      }).ref ?? undefined);
  const shouldAuditMcpValue =
    isMcpTarget &&
    shouldAuditPlaintextMcpValue({
      name: target.pathSegments.at(-1) ?? "",
      value: target.value,
    });
  const hasPlaintext =
    shouldAuditMcpValue ||
    hasConfiguredPlaintextSecretValue(target.value, target.entry.expectedResolvedValue);
  const isNonSecretHeader =
    target.entry.id === "models.providers.*.headers.*" &&
    !isLikelySensitiveModelProviderHeaderName(target.pathSegments.at(-1) ?? "");
  const isModelMarker =
    target.entry.id === "models.providers.*.apiKey" &&
    typeof target.value === "string" &&
    isNonSecretApiKeyMarker(target.value);
  return {
    ref,
    hasPlaintext,
    skipPlaintext: isNonSecretHeader || isModelMarker || (isMcpTarget && !shouldAuditMcpValue),
  };
}
