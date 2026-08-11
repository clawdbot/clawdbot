// Gateway client bootstrap resolver.
// Collects URL, auth, and handshake settings before constructing a GatewayClient.
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import {
  resolveGatewayInteractiveSurfaceAuth,
  resolveGatewayProbeSurfaceAuth,
} from "./auth-surface-resolution.js";
import {
  buildGatewayConnectionDetailsWithResolvers,
  type GatewayConnectionDetails,
} from "./connection-details.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  resolveExplicitGatewayAuth,
  trimToUndefined,
  type ExplicitGatewayAuth,
  type GatewayCredentialMode,
} from "./credentials.js";
import { resolveGatewayConnectionTlsFingerprint } from "./tls-fingerprint.js";

/**
 * Maps connection-detail source labels to the override kinds that affect auth fallback.
 */
function resolveGatewayUrlOverrideSource(urlSource: string): "cli" | "env" | undefined {
  if (urlSource === "cli --url") {
    return "cli";
  }
  if (urlSource === "env OPENCLAW_GATEWAY_URL") {
    return "env";
  }
  return undefined;
}

export class GatewayExplicitAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayExplicitAuthRequiredError";
  }
}

export function ensureExplicitGatewayAuth(params: {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  explicitAuth?: ExplicitGatewayAuth;
  resolvedAuth?: ExplicitGatewayAuth;
  deviceAuthScope?: string;
  allowStoredOriginAuth?: (scope: string) => boolean;
  errorHint: string;
  configPath?: string;
}): void {
  if (!params.urlOverride || !params.urlOverrideSource) {
    return;
  }
  if (params.explicitAuth?.token || params.explicitAuth?.password) {
    return;
  }
  if (
    params.urlOverrideSource === "env" &&
    (params.resolvedAuth?.token || params.resolvedAuth?.password)
  ) {
    return;
  }
  if (params.deviceAuthScope && params.allowStoredOriginAuth?.(params.deviceAuthScope) === true) {
    return;
  }
  const sourceHint =
    params.urlOverrideSource === "env"
      ? "Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD alongside OPENCLAW_GATEWAY_URL; config credentials are intentionally not reused."
      : "For the default local or SSH-tunneled Gateway, remove --url to use the configured target.";
  throw new GatewayExplicitAuthRequiredError(
    [
      "gateway url override requires explicit credentials",
      params.errorHint,
      sourceHint,
      params.configPath ? `Config: ${params.configPath}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

type GatewayClientBootstrapAuthPolicy = "default" | "interactive" | "probe";

/** Resolve the only URL overrides allowed to displace configured Gateway targets. */
export function resolveGatewayUrlOverride(params: {
  gatewayUrl?: string;
  env?: NodeJS.ProcessEnv;
  ignoreEnvUrlOverride?: boolean;
  localPortOverride?: number;
}): { url?: string; source?: "cli" | "env" } {
  const cliUrl = trimToUndefined(params.gatewayUrl);
  if (cliUrl) {
    return { url: cliUrl, source: "cli" };
  }
  if (params.ignoreEnvUrlOverride || params.localPortOverride !== undefined) {
    return {};
  }
  const envUrl = trimToUndefined((params.env ?? process.env).OPENCLAW_GATEWAY_URL);
  return envUrl ? { url: envUrl, source: "env" } : {};
}

/**
 * Resolves the URL, auth material, and handshake tuning needed to start a GatewayClient.
 */
export async function resolveGatewayClientBootstrap(params: {
  config: OpenClawConfig;
  gatewayUrl?: string;
  explicitAuth?: ExplicitGatewayAuth;
  env?: NodeJS.ProcessEnv;
  authPolicy?: GatewayClientBootstrapAuthPolicy;
  modeOverride?: GatewayCredentialMode;
  ignoreEnvUrlOverride?: boolean;
  localPortOverride?: number;
  configPath?: string;
  explicitTlsFingerprint?: string;
  skipImplicitAuth?: boolean;
  allowStoredOriginAuth?: (scope: string) => boolean;
  overrideAuthErrorHint?: string;
  buildConnectionDetails?: (options: {
    config: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
    ignoreEnvUrlOverride?: boolean;
    localPortOverride?: number;
  }) => GatewayConnectionDetails;
  resolveTlsFingerprint?: (params: {
    config: OpenClawConfig;
    url: string;
    urlSource: string;
    explicitTlsFingerprint?: string;
  }) => Promise<string | undefined>;
}): Promise<{
  url: string;
  urlSource: string;
  connectionDetails: GatewayConnectionDetails;
  urlOverrideSource?: "cli" | "env";
  deviceAuthScope?: string;
  authFailureReason?: string;
  preauthHandshakeTimeoutMs?: number;
  tlsFingerprint?: string;
  auth: {
    token?: string;
    password?: string;
  };
}> {
  const env = params.env ?? process.env;
  const explicitAuth = resolveExplicitGatewayAuth(params.explicitAuth);
  const urlOverride = resolveGatewayUrlOverride({
    gatewayUrl: params.gatewayUrl,
    env,
    ignoreEnvUrlOverride: params.ignoreEnvUrlOverride,
    localPortOverride: params.localPortOverride,
  });
  const buildConnectionDetails =
    params.buildConnectionDetails ?? buildGatewayConnectionDetailsWithResolvers;
  const connection = buildConnectionDetails({
    config: params.config,
    url: urlOverride.url,
    ...(params.configPath ? { configPath: params.configPath } : {}),
    ...(urlOverride.source ? { urlSource: urlOverride.source } : {}),
    ignoreEnvUrlOverride: true,
    ...(params.localPortOverride !== undefined
      ? { localPortOverride: params.localPortOverride }
      : {}),
  });
  const detectedUrlOverrideSource = resolveGatewayUrlOverrideSource(connection.urlSource);
  const urlOverrideSource = urlOverride.source ?? detectedUrlOverrideSource;
  const tlsFingerprint = params.resolveTlsFingerprint
    ? await params.resolveTlsFingerprint({
        config: params.config,
        url: connection.url,
        urlSource: connection.urlSource,
        explicitTlsFingerprint: params.explicitTlsFingerprint,
      })
    : await resolveGatewayConnectionTlsFingerprint({
        config: params.config,
        url: connection.url,
        urlSource: connection.urlSource,
        explicitTlsFingerprint: params.explicitTlsFingerprint,
        loadGatewayTlsRuntime,
      });
  // Only direct CLI/env URL overrides should constrain token/password fallback. Config-derived
  // remote URLs are canonical config, not a caller override.
  const surface =
    params.modeOverride ?? (params.config.gateway?.mode === "remote" ? "remote" : "local");
  let auth: { token?: string; password?: string; failureReason?: string };
  if (params.skipImplicitAuth) {
    auth = explicitAuth;
  } else if (urlOverrideSource) {
    auth = await resolveGatewayCredentialsWithSecretInputs({
      config: params.config,
      explicitAuth,
      env,
      urlOverride: connection.url,
      urlOverrideSource,
      modeOverride: params.modeOverride,
    });
  } else if (params.authPolicy === "probe") {
    auth = await resolveGatewayProbeSurfaceAuth({ config: params.config, env, surface });
  } else if (params.authPolicy === "interactive") {
    auth = await resolveGatewayInteractiveSurfaceAuth({
      config: params.config,
      env,
      explicitAuth,
      surface,
    });
  } else {
    auth = await resolveGatewayCredentialsWithSecretInputs({
      config: params.config,
      explicitAuth,
      env,
      urlOverride: urlOverrideSource ? connection.url : undefined,
      urlOverrideSource,
      modeOverride: params.modeOverride,
    });
  }
  const deviceAuthScope =
    urlOverrideSource || params.config.gateway?.mode === "remote"
      ? gatewayOriginScope(connection.url)
      : undefined;
  if (params.overrideAuthErrorHint) {
    ensureExplicitGatewayAuth({
      urlOverride: urlOverrideSource ? connection.url : undefined,
      urlOverrideSource,
      explicitAuth,
      resolvedAuth: auth,
      deviceAuthScope,
      allowStoredOriginAuth: params.allowStoredOriginAuth,
      errorHint: params.overrideAuthErrorHint ?? "Fix: pass --token or --password with --url.",
      configPath: params.configPath,
    });
  }
  return {
    url: connection.url,
    urlSource: connection.urlSource,
    connectionDetails: connection,
    ...(urlOverrideSource ? { urlOverrideSource } : {}),
    ...(deviceAuthScope ? { deviceAuthScope } : {}),
    ...(auth.failureReason ? { authFailureReason: auth.failureReason } : {}),
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
    auth: {
      token: auth.token,
      password: auth.password,
    },
  };
}
