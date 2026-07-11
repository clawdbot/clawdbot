// Gateway auth surface resolver.
// Centralizes credential precedence for probes and interactive clients.
import type { OpenClawConfig } from "../config/types.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";
import { resolveConfiguredSecretInputString } from "./resolve-configured-secret-input-string.js";

// Gateway auth is resolved differently for passive probes and interactive
// clients. This module owns the shared precedence so CLI, UI, and remote
// surfaces do not silently choose different token/password sources.
type GatewayCredentialPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

type ResolvedGatewayCredential = {
  value?: string;
  unresolvedRefReason?: string;
};

async function resolveGatewayCredential(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  diagnostics: string[];
  path: GatewayCredentialPath;
  value: unknown;
}): Promise<ResolvedGatewayCredential> {
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env,
    value: params.value,
    path: params.path,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.unresolvedRefReason) {
    params.diagnostics.push(resolved.unresolvedRefReason);
  }
  return resolved;
}

function withDiagnostics<T extends object>(params: {
  diagnostics: string[];
  result: T;
}): T & { diagnostics?: string[] } {
  return params.diagnostics.length > 0
    ? { ...params.result, diagnostics: params.diagnostics }
    : params.result;
}

/** Resolves best-effort credentials for non-mutating local/remote gateway probes. */
export async function resolveGatewayProbeSurfaceAuth(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  surface: "local" | "remote";
}): Promise<{
  token?: string;
  password?: string;
  diagnostics?: string[];
  source?: "config" | "env";
}> {
  const env = params.env ?? process.env;
  const diagnostics: string[] = [];
  const authMode = params.config.gateway?.auth?.mode;

  if (params.surface === "remote") {
    // Remote probes keep configured auth authoritative, then fall back to the
    // same environment credentials supported by interactive remote clients.
    const remoteToken = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: "gateway.remote.token",
      value: params.config.gateway?.remote?.token,
    });
    const remotePassword = remoteToken.value
      ? { value: undefined }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.remote.password",
          value: params.config.gateway?.remote?.password,
        });
    const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
    const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
    const hasConfiguredAuth = Boolean(remoteToken.value || remotePassword.value);
    return withDiagnostics({
      diagnostics,
      result: {
        token: remoteToken.value ?? (hasConfiguredAuth ? undefined : envToken),
        password: remotePassword.value ?? (hasConfiguredAuth ? undefined : envPassword),
        ...(hasConfiguredAuth
          ? { source: "config" as const }
          : (envToken || envPassword) && { source: "env" as const }),
      },
    });
  }

  if (authMode === "none" || authMode === "trusted-proxy") {
    return {};
  }

  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  if (authMode === "token") {
    const token = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: "gateway.auth.token",
      value: params.config.gateway?.auth?.token,
    });
    return token.value
      ? withDiagnostics({
          diagnostics,
          result: { token: token.value, source: "config" as const },
        })
      : envToken
        ? { token: envToken, source: "env" }
        : withDiagnostics({ diagnostics, result: {} });
  }

  if (authMode === "password") {
    const password = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: "gateway.auth.password",
      value: params.config.gateway?.auth?.password,
    });
    return password.value
      ? withDiagnostics({
          diagnostics,
          result: { password: password.value, source: "config" as const },
        })
      : envPassword
        ? { password: envPassword, source: "env" }
        : withDiagnostics({ diagnostics, result: {} });
  }

  const token = await resolveGatewayCredential({
    config: params.config,
    env,
    diagnostics,
    path: "gateway.auth.token",
    value: params.config.gateway?.auth?.token,
  });
  if (token.value) {
    return withDiagnostics({
      diagnostics,
      result: { token: token.value, source: "config" as const },
    });
  }
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  if (envPassword) {
    return withDiagnostics({
      diagnostics,
      result: { password: envPassword, source: "env" as const },
    });
  }
  // In implicit local mode, config password is the final fallback after token
  // sources and env auth have been exhausted.
  const password = await resolveGatewayCredential({
    config: params.config,
    env,
    diagnostics,
    path: "gateway.auth.password",
    value: params.config.gateway?.auth?.password,
  });
  return withDiagnostics({
    diagnostics,
    result: {
      token: token.value,
      password: password.value,
      ...(password.value && { source: "config" as const }),
    },
  });
}

/** Resolves credentials for client paths that must either authenticate or explain the failure. */
export async function resolveGatewayInteractiveSurfaceAuth(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  suppressEnvAuthFallback?: boolean;
  surface: "local" | "remote";
}): Promise<{
  token?: string;
  password?: string;
  failureReason?: string;
}> {
  const env = params.env ?? process.env;
  const diagnostics: string[] = [];
  const explicitToken = trimToUndefined(params.explicitAuth?.token);
  const explicitPassword = trimToUndefined(params.explicitAuth?.password);
  const envToken = params.suppressEnvAuthFallback
    ? undefined
    : trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = params.suppressEnvAuthFallback
    ? undefined
    : trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  if (params.surface === "remote") {
    // Interactive remote clients allow explicit/env password fallback because
    // users may connect to a gateway they do not own locally.
    const remoteToken = explicitToken
      ? { value: explicitToken }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.remote.token",
          value: params.config.gateway?.remote?.token,
        });
    const remotePassword =
      explicitPassword || envPassword
        ? { value: explicitPassword ?? envPassword }
        : await resolveGatewayCredential({
            config: params.config,
            env,
            diagnostics,
            path: "gateway.remote.password",
            value: params.config.gateway?.remote?.password,
          });
    const token = explicitToken ?? remoteToken.value ?? envToken;
    const password = explicitPassword ?? envPassword ?? remotePassword.value;
    return token || password
      ? { token, password }
      : {
          failureReason:
            remoteToken.unresolvedRefReason ??
            remotePassword.unresolvedRefReason ??
            "Missing gateway auth credentials.",
        };
  }

  const authMode = params.config.gateway?.auth?.mode;
  if (authMode === "none" || authMode === "trusted-proxy") {
    return {
      token: explicitToken ?? envToken,
      password: explicitPassword ?? envPassword,
    };
  }

  const hasConfiguredToken = hasConfiguredSecretInput(
    params.config.gateway?.auth?.token,
    params.config.secrets?.defaults,
  );
  const hasConfiguredPassword = hasConfiguredSecretInput(
    params.config.gateway?.auth?.password,
    params.config.secrets?.defaults,
  );

  const resolveToken = async () => {
    const localToken = explicitToken
      ? { value: explicitToken }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.auth.token",
          value: params.config.gateway?.auth?.token,
        });
    const token = explicitToken ?? localToken.value ?? envToken;
    return {
      token,
      failureReason: token
        ? undefined
        : (localToken.unresolvedRefReason ?? "Missing gateway auth token."),
    };
  };

  const resolvePassword = async () => {
    const localPassword =
      explicitPassword || envPassword
        ? { value: explicitPassword ?? envPassword }
        : await resolveGatewayCredential({
            config: params.config,
            env,
            diagnostics,
            path: "gateway.auth.password",
            value: params.config.gateway?.auth?.password,
          });
    const password = explicitPassword ?? envPassword ?? localPassword.value;
    return {
      password,
      failureReason: password
        ? undefined
        : (localPassword.unresolvedRefReason ?? "Missing gateway auth password."),
    };
  };

  if (authMode === "password") {
    const password = await resolvePassword();
    return {
      token: explicitToken ?? envToken,
      password: password.password,
      failureReason: password.failureReason,
    };
  }

  if (authMode === "token") {
    const token = await resolveToken();
    return {
      token: token.token,
      password: explicitPassword ?? envPassword,
      failureReason: token.failureReason,
    };
  }

  const shouldUsePassword =
    Boolean(explicitPassword ?? envPassword) || (hasConfiguredPassword && !hasConfiguredToken);
  if (shouldUsePassword) {
    const password = await resolvePassword();
    return {
      token: explicitToken ?? envToken,
      password: password.password,
      failureReason: password.failureReason,
    };
  }

  const token = await resolveToken();
  return {
    token: token.token,
    password: explicitPassword ?? envPassword,
    failureReason: token.failureReason,
  };
}
