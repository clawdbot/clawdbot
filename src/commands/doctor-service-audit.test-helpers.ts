import { isEnvironmentFileOnlySource } from "../daemon/service-managed-env.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const testServiceAuditCodes = {
  gatewayCommandMissing: "gateway-command-missing",
  gatewayEntrypointMismatch: "gateway-entrypoint-mismatch",
  gatewayManagedEnvEmbedded: "gateway-managed-env-embedded",
  gatewayPortMismatch: "gateway-port-mismatch",
  gatewayProxyEnvEmbedded: "gateway-proxy-env-embedded",
  gatewayTokenMismatch: "gateway-token-mismatch",
} as const;

export function readEmbeddedGatewayTokenForTest(
  command: {
    environment?: Record<string, string>;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
  } | null,
) {
  return isEnvironmentFileOnlySource(command?.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN)
    ? undefined
    : normalizeOptionalString(command?.environment?.OPENCLAW_GATEWAY_TOKEN);
}
