// Gateway auth surface resolver.
// Centralizes credential precedence for probes and interactive clients.
import type { OpenClawConfig } from "../config/types.js";
import { createGatewayCredentialPlan } from "./credential-planner.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";
import { resolveConfiguredSecretInputWithFallback } from "./resolve-configured-secret-input-string.js";

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
  secretRefConfigured: boolean;
};

async function resolveGatewayCredential(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  diagnostics: string[];
  path: GatewayCredentialPath;
  value: unknown;
}): Promise<ResolvedGatewayCredential> {
  const resolved = await resolveConfiguredSecretInputWithFallback({
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

function withDiagnostics<T extends object>(
  diagnostics: string[],
  result: T,
): T & { diagnostics?: string[] } {
  return diagnostics.length > 0 ? { ...result, diagnostics } : result;
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
    const remoteToken = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: "gateway.remote.token",
      value: params.config.gateway?.remote?.token,
    });
    const remotePassword = remoteToken.value
      ? { value: undefined, secretRefConfigured: false }
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
    // A failed remote ref may retain a healthy configured sibling, never an
    // ambient credential that would hide the operator's selected secret owner.
    const allowEnvAuth = !hasConfiguredAuth && diagnostics.length === 0;
    return withDiagnostics(diagnostics, {
      token: remoteToken.value ?? (allowEnvAuth ? envToken : undefined),
      password: remotePassword.value ?? (allowEnvAuth ? envPassword : undefined),
      ...(hasConfiguredAuth
        ? { source: "config" as const }
        : allowEnvAuth && (envToken || envPassword) && { source: "env" as const }),
    });
  }

  if (authMode === "none" || authMode === "trusted-proxy") {
    return {};
  }

  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  if (authMode === "token" || authMode === "password") {
    const credential = await resolveGatewayCredential({
      config: params.config,
      env,
      diagnostics,
      path: `gateway.auth.${authMode}`,
      value: params.config.gateway?.auth?.[authMode],
    });
    if (credential.value) {
      return withDiagnostics(diagnostics, {
        [authMode]: credential.value,
        source: "config" as const,
      });
    }
    const envCredential = authMode === "token" ? envToken : envPassword;
    return !credential.secretRefConfigured && envCredential
      ? { [authMode]: envCredential, source: "env" }
      : withDiagnostics(diagnostics, {});
  }

  const token = await resolveGatewayCredential({
    config: params.config,
    env,
    diagnostics,
    path: "gateway.auth.token",
    value: params.config.gateway?.auth?.token,
  });
  if (token.value) {
    return withDiagnostics(diagnostics, { token: token.value, source: "config" as const });
  }
  if (token.secretRefConfigured) {
    return withDiagnostics(diagnostics, {});
  }
  const password = await resolveGatewayCredential({
    config: params.config,
    env,
    diagnostics,
    path: "gateway.auth.password",
    value: params.config.gateway?.auth?.password,
  });
  if (password.secretRefConfigured) {
    return withDiagnostics(
      diagnostics,
      password.value ? { password: password.value, source: "config" as const } : {},
    );
  }
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  if (envPassword) {
    return withDiagnostics(diagnostics, { password: envPassword, source: "env" as const });
  }
  // Plaintext passwords retain their original position after ambient auth;
  // configured password refs were resolved authoritatively above.
  return withDiagnostics(diagnostics, {
    token: token.value,
    password: password.value,
    ...(password.value && { source: "config" as const }),
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
  const credentialPlan = createGatewayCredentialPlan({ config: params.config, env });
  const authMode = params.config.gateway?.auth?.mode;
  const hasActiveSecretRef =
    params.surface === "remote"
      ? credentialPlan.remoteToken.hasSecretRef || credentialPlan.remotePassword.hasSecretRef
      : (credentialPlan.localTokenCanWin && credentialPlan.localToken.hasSecretRef) ||
        ((authMode === "password" || authMode === undefined) &&
          credentialPlan.localPassword.hasSecretRef);
  if ((explicitToken || explicitPassword) && hasActiveSecretRef) {
    return { token: explicitToken, password: explicitPassword };
  }
  const envToken = params.suppressEnvAuthFallback
    ? undefined
    : trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = params.suppressEnvAuthFallback
    ? undefined
    : trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  if (params.surface === "remote") {
    const remoteToken = explicitToken
      ? { value: explicitToken, secretRefConfigured: false }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.remote.token",
          value: params.config.gateway?.remote?.token,
        });
    if (
      remoteToken.value &&
      (remoteToken.secretRefConfigured || credentialPlan.remotePassword.hasSecretRef)
    ) {
      return { token: remoteToken.value, password: undefined };
    }
    const remotePassword = explicitPassword
      ? { value: explicitPassword, secretRefConfigured: false }
      : await resolveGatewayCredential({
          config: params.config,
          env,
          diagnostics,
          path: "gateway.remote.password",
          value: params.config.gateway?.remote?.password,
        });
    const secretRefConfigured =
      remoteToken.secretRefConfigured || remotePassword.secretRefConfigured;
    const token = remoteToken.value ?? (secretRefConfigured ? undefined : envToken);
    const password =
      explicitPassword ??
      (secretRefConfigured ? remotePassword.value : (envPassword ?? remotePassword.value));
    return token || password
      ? { token, password }
      : {
          failureReason:
            remoteToken.unresolvedRefReason ??
            remotePassword.unresolvedRefReason ??
            "Missing gateway auth credentials.",
        };
  }

  if (authMode === "none" || authMode === "trusted-proxy") {
    return {
      token: explicitToken ?? envToken,
      password: explicitPassword ?? envPassword,
    };
  }

  const shouldUsePassword =
    authMode === "password" ||
    (authMode !== "token" &&
      ((Boolean(explicitPassword ?? envPassword) && !credentialPlan.localToken.hasSecretRef) ||
        (credentialPlan.localPassword.configured && !credentialPlan.localToken.configured)));
  const credentialKind = shouldUsePassword ? "password" : "token";
  const explicitCredential = shouldUsePassword ? explicitPassword : explicitToken;
  const envCredential = shouldUsePassword ? envPassword : envToken;
  const credential = explicitCredential
    ? { value: explicitCredential, secretRefConfigured: false }
    : await resolveGatewayCredential({
        config: params.config,
        env,
        diagnostics,
        path: `gateway.auth.${credentialKind}`,
        value: params.config.gateway?.auth?.[credentialKind],
      });
  const value = credential.value ?? (credential.secretRefConfigured ? undefined : envCredential);
  return {
    token: shouldUsePassword
      ? credential.secretRefConfigured
        ? undefined
        : (explicitToken ?? envToken)
      : value,
    password: shouldUsePassword
      ? value
      : credential.secretRefConfigured
        ? undefined
        : (explicitPassword ?? envPassword),
    failureReason: value
      ? undefined
      : (credential.unresolvedRefReason ?? `Missing gateway auth ${credentialKind}.`),
  };
}
