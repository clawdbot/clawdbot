import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveSecretInputString } from "../secrets/resolve-secret-input-string.js";
import {
  GatewaySecretRefUnavailableError,
  resolveGatewayCredentialsFromConfig,
  trimToUndefined,
  type ExplicitGatewayAuth,
  type GatewayCredentialMode,
  type GatewayCredentialPrecedence,
  type GatewayRemoteCredentialFallback,
  type GatewayRemoteCredentialPrecedence,
} from "./credentials.js";
import {
  ALL_GATEWAY_SECRET_INPUT_PATHS,
  assignResolvedGatewaySecretInput,
  isSupportedGatewaySecretInputPath,
  isTokenGatewaySecretInputPath,
  readGatewaySecretInputValue,
  type SupportedGatewaySecretInputPath,
} from "./secret-input-paths.js";

export type GatewayCredentialSecretInputOptions = {
  config: OpenClawConfig;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  env?: NodeJS.ProcessEnv;
  modeOverride?: GatewayCredentialMode;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
};

type NormalizedGatewayCredentialSecretInputOptions = Omit<
  GatewayCredentialSecretInputOptions,
  "explicitAuth"
> & {
  explicitAuth: ExplicitGatewayAuth;
};

function resolveExplicitGatewayAuth(opts?: ExplicitGatewayAuth): ExplicitGatewayAuth {
  const token =
    typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : undefined;
  const password =
    typeof opts?.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined;
  return { token, password };
}

async function resolveGatewaySecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const value = await resolveSecretInputString({
    config: params.config,
    value: params.value,
    env: params.env,
    normalize: trimToUndefined,
    onResolveRefError: () => {
      throw new GatewaySecretRefUnavailableError(params.path);
    },
  });
  if (!value) {
    throw new Error(`${params.path} resolved to an empty or non-string value.`);
  }
  return value;
}

function hasConfiguredGatewaySecretRef(
  config: OpenClawConfig,
  path: SupportedGatewaySecretInputPath,
): boolean {
  return Boolean(
    resolveSecretInputRef({
      value: readGatewaySecretInputValue(config, path),
      defaults: config.secrets?.defaults,
    }).ref,
  );
}

function resolveGatewayCredentialsFromConfigOptions(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  options: NormalizedGatewayCredentialSecretInputOptions;
}) {
  const { cfg, env, options } = params;
  return {
    cfg,
    env,
    explicitAuth: options.explicitAuth,
    urlOverride: options.urlOverride,
    urlOverrideSource: options.urlOverrideSource,
    modeOverride: options.modeOverride,
    localTokenPrecedence: options.localTokenPrecedence,
    localPasswordPrecedence: options.localPasswordPrecedence,
    remoteTokenPrecedence: options.remoteTokenPrecedence,
    remotePasswordPrecedence: options.remotePasswordPrecedence ?? "env-first", // pragma: allowlist secret
    remoteTokenFallback: options.remoteTokenFallback,
    remotePasswordFallback: options.remotePasswordFallback,
  } as const;
}

function localAuthModeAllowsGatewaySecretInputPath(params: {
  authMode: string | undefined;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  const { authMode, path } = params;
  if (authMode === "none" || authMode === "trusted-proxy") {
    return false;
  }
  if (authMode === "token") {
    return isTokenGatewaySecretInputPath(path);
  }
  if (authMode === "password") {
    return !isTokenGatewaySecretInputPath(path);
  }
  return true;
}

function gatewaySecretInputPathCanWin(params: {
  options: NormalizedGatewayCredentialSecretInputOptions;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  if (!hasConfiguredGatewaySecretRef(params.config, params.path)) {
    return false;
  }
  const mode: GatewayCredentialMode =
    params.options.modeOverride ?? (params.config.gateway?.mode === "remote" ? "remote" : "local");
  if (
    mode === "local" &&
    !localAuthModeAllowsGatewaySecretInputPath({
      authMode: params.config.gateway?.auth?.mode,
      path: params.path,
    })
  ) {
    return false;
  }
  const sentinel = `__OPENCLAW_GATEWAY_SECRET_REF_PROBE_${params.path.replaceAll(".", "_")}__`;
  const probeConfig = structuredClone(params.config);
  for (const candidatePath of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (!hasConfiguredGatewaySecretRef(probeConfig, candidatePath)) {
      continue;
    }
    assignResolvedGatewaySecretInput({
      config: probeConfig,
      path: candidatePath,
      value: undefined,
    });
  }
  assignResolvedGatewaySecretInput({
    config: probeConfig,
    path: params.path,
    value: sentinel,
  });
  try {
    const resolved = resolveGatewayCredentialsFromConfig(
      resolveGatewayCredentialsFromConfigOptions({
        cfg: probeConfig,
        env: params.env,
        options: params.options,
      }),
    );
    const tokenCanWin = resolved.token === sentinel && !resolved.password;
    const passwordCanWin = resolved.password === sentinel && !resolved.token;
    return tokenCanWin || passwordCanWin;
  } catch {
    return false;
  }
}

async function resolveConfiguredGatewaySecretInput(params: {
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  return resolveGatewaySecretInputString({
    config: params.config,
    value: readGatewaySecretInputValue(params.config, params.path),
    path: params.path,
    env: params.env,
  });
}

async function resolvePreferredGatewaySecretInputs(params: {
  options: NormalizedGatewayCredentialSecretInputOptions;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
}): Promise<OpenClawConfig> {
  let nextConfig = params.config;
  for (const path of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (
      !gatewaySecretInputPathCanWin({
        options: params.options,
        env: params.env,
        config: nextConfig,
        path,
      })
    ) {
      continue;
    }
    if (nextConfig === params.config) {
      nextConfig = structuredClone(params.config);
    }
    try {
      const resolvedValue = await resolveConfiguredGatewaySecretInput({
        config: nextConfig,
        path,
        env: params.env,
      });
      assignResolvedGatewaySecretInput({
        config: nextConfig,
        path,
        value: resolvedValue,
      });
    } catch {
      // Keep scanning candidate paths so unresolved higher-priority refs do not
      // prevent valid fallback refs from being considered.
      continue;
    }
  }
  return nextConfig;
}

async function resolveGatewayCredentialsFromConfigWithSecretInputs(params: {
  options: NormalizedGatewayCredentialSecretInputOptions;
  env: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  let resolvedConfig = await resolvePreferredGatewaySecretInputs({
    options: params.options,
    env: params.env,
    config: params.options.config,
  });
  const resolvedPaths = new Set<SupportedGatewaySecretInputPath>();
  for (;;) {
    try {
      return resolveGatewayCredentialsFromConfig(
        resolveGatewayCredentialsFromConfigOptions({
          cfg: resolvedConfig,
          env: params.env,
          options: params.options,
        }),
      );
    } catch (error) {
      if (!(error instanceof GatewaySecretRefUnavailableError)) {
        throw error;
      }
      const path = error.path;
      if (!isSupportedGatewaySecretInputPath(path) || resolvedPaths.has(path)) {
        throw error;
      }
      if (resolvedConfig === params.options.config) {
        resolvedConfig = structuredClone(params.options.config);
      }
      const resolvedValue = await resolveConfiguredGatewaySecretInput({
        config: resolvedConfig,
        path,
        env: params.env,
      });
      assignResolvedGatewaySecretInput({
        config: resolvedConfig,
        path,
        value: resolvedValue,
      });
      resolvedPaths.add(path);
    }
  }
}

export async function resolveGatewayCredentialsWithSecretInputs(
  params: GatewayCredentialSecretInputOptions,
): Promise<{ token?: string; password?: string }> {
  const options: NormalizedGatewayCredentialSecretInputOptions = {
    ...params,
    explicitAuth: resolveExplicitGatewayAuth(params.explicitAuth),
  };
  if (options.explicitAuth.token || options.explicitAuth.password) {
    return {
      token: options.explicitAuth.token,
      password: options.explicitAuth.password,
    };
  }
  return await resolveGatewayCredentialsFromConfigWithSecretInputs({
    options,
    env: params.env ?? process.env,
  });
}
