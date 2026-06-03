import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";

type GatewayCredentialConfigOptions = Parameters<typeof resolveGatewayCredentialsFromConfig>[0];

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

export async function resolveGatewayConnectionAuth(
  params: GatewayConnectionAuthOptions,
): Promise<{ token?: string; password?: string }> {
  return await resolveGatewayCredentialsWithSecretInputs({
    config: params.config,
    ...toGatewayCredentialOptions(params),
  });
}

export function resolveGatewayConnectionAuthFromConfig(params: GatewayCredentialConfigOptions): {
  token?: string;
  password?: string;
} {
  return resolveGatewayCredentialsFromConfig(params);
}
