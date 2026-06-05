// Gateway connection auth facade.
// Resolves config-backed client credentials with or without async SecretRefs.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";

// Thin public bridge from OpenClawConfig-shaped callers to the lower-level
// credential resolver. Keep this file policy-free; precedence lives in
// credentials-secret-inputs and credentials.
type GatewayCredentialConfigOptions = Parameters<typeof resolveGatewayCredentialsFromConfig>[0];

/** Connection auth options accepted by gateway clients that already loaded config. */
export type GatewayConnectionAuthOptions = Omit<GatewayCredentialConfigOptions, "cfg"> & {
  config: OpenClawConfig;
};

function toGatewayCredentialOptions(
  params: GatewayConnectionAuthOptions,
): GatewayCredentialConfigOptions {
  const { config, ...rest } = params;
  return {
    cfg: config,
    ...rest,
  };
}

/** Resolves gateway connection credentials, including configured SecretRef inputs. */
export async function resolveGatewayConnectionAuth(
  params: GatewayConnectionAuthOptions,
): Promise<{ token?: string; password?: string }> {
  return await resolveGatewayCredentialsWithSecretInputs({
    config: params.config,
    ...toGatewayCredentialOptions(params),
  });
}

/** Resolves already-available config credentials without async SecretRef loading. */
export function resolveGatewayConnectionAuthFromConfig(params: GatewayCredentialConfigOptions): {
  token?: string;
  password?: string;
} {
  return resolveGatewayCredentialsFromConfig(params);
}
