import crypto from "node:crypto";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

/** Ephemeral proof of the credential or opaque runtime that completed one agent run. */
export type AgentExecutionAuthBinding = {
  authProfileId?: string;
  /** Exact embedded harness that completed the successful turn, including openclaw. */
  agentHarnessId?: string;
  /** Exact model selected by the successful embedded run. */
  modelId?: string;
  /** Exact transport used to select that run's credential. */
  modelApi?: string;
  /** Non-reversible identity hash; credential material never leaves the runner. */
  authFingerprint?: string;
  /** Runtime-owned principal/session shape used when credentials are intentionally opaque. */
  runtimeOwnerFingerprint?: string;
  /** Exact opaque owner, or plugin harness carrying a credential-backed turn. */
  runtimeOwnerKind?: OpaqueRuntimeOwnerKind;
  /** Exact backend/harness id that owned the successful turn. */
  runtimeOwnerId?: string;
  /** Exact CLI or plugin-harness implementation used by the successful turn. */
  runtimeArtifactFingerprint?: string;
  runtimeArtifactId?: string;
  /** The prepared CLI bridge used only the selected profile, not ambient CLI auth. */
  skipLocalCredential?: true;
};

export type OpaqueRuntimeOwnerKind = "cli-runtime" | "plugin-harness" | "aws-sdk";

// Fingerprints are process-local proofs. Restarting rotates this key and
// invalidates them instead of leaving a reusable offline digest of a secret.
const authBindingFingerprintKey = crypto.randomBytes(32);

function hashAuthBinding(value: unknown): string {
  return crypto
    .createHmac("sha256", authBindingFingerprintKey)
    .update(JSON.stringify(value))
    .digest("hex");
}

function normalizeIdentity(value: string | undefined, lowercase = false): string | undefined {
  const normalized = value?.trim();
  return normalized ? (lowercase ? normalized.toLowerCase() : normalized) : undefined;
}

/**
 * Project non-secret profile ownership for runtimes that keep rotating tokens
 * behind their own process boundary. An explicitly selected missing profile
 * has no owner shape and must never collapse to ambient runtime authority.
 */
export function fingerprintAuthProfileOwnerShape(params: {
  profileId: string;
  credential: AuthProfileCredential | undefined;
}): string | undefined {
  const credential = params.credential;
  if (!credential) {
    return undefined;
  }
  switch (credential.type) {
    case "api_key":
      return hashAuthBinding([
        "profile-owner-v1",
        params.profileId,
        credential.type,
        credential.provider,
        credential.keyRef ?? null,
        normalizeIdentity(credential.email, true) ?? null,
        normalizeIdentity(credential.displayName) ?? null,
        credential.metadata ?? null,
      ]);
    case "token":
      return hashAuthBinding([
        "profile-owner-v1",
        params.profileId,
        credential.type,
        credential.provider,
        credential.tokenRef ?? null,
        normalizeIdentity(credential.email, true) ?? null,
        normalizeIdentity(credential.displayName) ?? null,
      ]);
    case "oauth": {
      const jwtIdentity = decodeJwtIdentity(credential.idToken);
      return hashAuthBinding([
        "profile-owner-v1",
        params.profileId,
        credential.type,
        credential.provider,
        normalizeIdentity(credential.accountId) ?? jwtIdentity.subject ?? null,
        normalizeIdentity(credential.email, true) ?? jwtIdentity.email ?? null,
        credential.clientId ?? null,
        credential.enterpriseUrl ?? null,
        credential.projectId ?? null,
      ]);
    }
  }
  return undefined;
}

/** Fingerprint the stable owner boundary of a successful opaque runtime turn. */
export function fingerprintOpaqueRuntimeOwner(params: {
  kind: OpaqueRuntimeOwnerKind;
  runner: "cli" | "embedded";
  provider: string;
  backendId: string;
  backendConfig?: unknown;
  authProfileId?: string;
  authProfileOwnerFingerprint?: string;
  authSource?: string;
  skipLocalCredential?: boolean;
  runtimeArtifactFingerprint?: string;
}): string | undefined {
  const runtimeArtifactFingerprint = params.runtimeArtifactFingerprint;
  const authProfileId = normalizeIdentity(params.authProfileId);
  if (authProfileId && !params.authProfileOwnerFingerprint) {
    return undefined;
  }
  if (!authProfileId && params.skipLocalCredential) {
    return undefined;
  }
  if (
    (params.kind === "cli-runtime" || params.kind === "plugin-harness") &&
    !runtimeArtifactFingerprint
  ) {
    return undefined;
  }
  return hashAuthBinding([
    params.kind === "aws-sdk" ? "opaque-runtime-owner-v1" : "opaque-runtime-owner-v2",
    params.kind,
    params.runner,
    params.provider.trim(),
    params.backendId,
    params.backendConfig ?? null,
    authProfileId ?? null,
    params.authProfileOwnerFingerprint ?? null,
    params.authSource ?? null,
    params.skipLocalCredential === true,
    runtimeArtifactFingerprint ?? null,
  ]);
}

/** Fingerprint only AWS SDK owners whose exact credential is observable here. */
export function fingerprintAwsSdkRuntimeOwner(params: {
  provider: string;
  backendId: string;
  auth: ResolvedProviderAuth | null | undefined;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (params.auth?.mode !== "aws-sdk" || params.auth.apiKey) {
    return undefined;
  }
  const env = params.env ?? process.env;
  let owner: unknown;
  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    owner = ["bearer", hashAuthBinding(env.AWS_BEARER_TOKEN_BEDROCK.trim())];
  } else if (env.AWS_PROFILE?.trim()) {
    // A profile name is not a principal: its role/source/SSO account can change
    // without the name changing. Supporting profiles and instance/container
    // roles requires provider-owned proof of the resolved account/ARN.
    return undefined;
  } else if (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) {
    owner = [
      "access-key",
      env.AWS_ACCESS_KEY_ID.trim(),
      hashAuthBinding([env.AWS_SECRET_ACCESS_KEY.trim(), env.AWS_SESSION_TOKEN?.trim() ?? null]),
    ];
  } else {
    return undefined;
  }
  return fingerprintOpaqueRuntimeOwner({
    kind: "aws-sdk",
    runner: "embedded",
    provider: params.provider,
    backendId: params.backendId,
    authSource: hashAuthBinding([params.auth.source, owner]),
  });
}

function decodeJwtIdentity(token: string | undefined): { subject?: string; email?: string } {
  const payload = token?.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      email?: unknown;
    };
    return {
      ...(typeof claims.sub === "string" && normalizeIdentity(claims.sub)
        ? { subject: normalizeIdentity(claims.sub) }
        : {}),
      ...(typeof claims.email === "string" && normalizeIdentity(claims.email, true)
        ? { email: normalizeIdentity(claims.email, true) }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Fingerprint the exact active credential owner used by one execution. */
export function fingerprintAuthProfileCredential(params: {
  profileId: string;
  credential: AuthProfileCredential;
}): string | undefined {
  const credential = params.credential;
  switch (credential.type) {
    case "api_key": {
      if (!credential.key) {
        return undefined;
      }
      return hashAuthBinding([
        "api_key",
        params.profileId,
        credential.provider,
        credential.key,
        credential.keyRef ?? null,
        credential.email ?? null,
        credential.displayName ?? null,
        credential.metadata ?? null,
      ]);
    }
    case "token": {
      if (!credential.token) {
        return undefined;
      }
      return hashAuthBinding([
        "token",
        params.profileId,
        credential.provider,
        credential.token,
        credential.tokenRef ?? null,
        credential.email ?? null,
        credential.displayName ?? null,
      ]);
    }
    case "oauth": {
      const jwtIdentity = decodeJwtIdentity(credential.idToken);
      const accountId = normalizeIdentity(credential.accountId) ?? jwtIdentity.subject;
      const email = normalizeIdentity(credential.email, true) ?? jwtIdentity.email;
      const stableIdentity = accountId ?? email;
      const opaqueIdentity = stableIdentity
        ? null
        : [credential.access, credential.refresh, credential.idToken ?? null];
      if (!stableIdentity && !credential.access && !credential.refresh && !credential.idToken) {
        return undefined;
      }
      return hashAuthBinding([
        "oauth",
        params.profileId,
        credential.provider,
        credential.clientId ?? null,
        accountId ?? null,
        email ?? null,
        credential.enterpriseUrl ?? null,
        credential.projectId ?? null,
        opaqueIdentity,
      ]);
    }
  }
  return undefined;
}

/** Fingerprint a profile after materializing its selected SecretRef value. */
export function fingerprintResolvedAuthProfileCredential(params: {
  profileId: string;
  credential: AuthProfileCredential;
  resolvedAuth: ResolvedProviderAuth | null | undefined;
}): string | undefined {
  const credential = params.credential;
  if (credential.type === "oauth") {
    return fingerprintAuthProfileCredential({ profileId: params.profileId, credential });
  }
  if (params.resolvedAuth && params.resolvedAuth.profileId !== params.profileId) {
    return undefined;
  }
  const inlineValue = credential.type === "api_key" ? credential.key : credential.token;
  const resolvedValue = params.resolvedAuth?.apiKey ?? inlineValue;
  if (!resolvedValue) {
    return undefined;
  }
  return fingerprintAuthProfileCredential({
    profileId: params.profileId,
    credential:
      credential.type === "api_key"
        ? { ...credential, key: resolvedValue }
        : { ...credential, token: resolvedValue },
  });
}

/** Fingerprint an ambient/config/env credential that was actually selected. */
export function fingerprintResolvedProviderAuth(
  auth: ResolvedProviderAuth | null | undefined,
): string | undefined {
  if (!auth?.apiKey) {
    return undefined;
  }
  return hashAuthBinding(["resolved", auth.profileId ?? null, auth.source, auth.mode, auth.apiKey]);
}
