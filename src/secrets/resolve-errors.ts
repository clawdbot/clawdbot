/** Typed errors for SecretRef provider and ref-level resolution failures. */
import type { SecretRef, SecretRefSource } from "../config/types.secrets.js";

type SecretRefResolutionCode =
  | "SECRET_REF_NOT_FOUND"
  | "SECRET_REF_POLICY_DENIED"
  | "SECRET_REF_INVALID"
  | "SECRET_REF_PROVIDER_ERROR"
  | "SECRET_REF_PROVIDER_CONTRACT";

type SecretProviderResolutionCode = "SECRET_PROVIDER_INVALID" | "SECRET_PROVIDER_UNAVAILABLE";

export type SecretResolutionFailureReason =
  | "secret provider failed"
  | "secret provider policy denied resolution"
  | "secret provider response violated its contract"
  | "secret reference was not found";

/** Error for failures that affect an entire configured secret provider. */
class SecretProviderResolutionError extends Error {
  readonly scope = "provider" as const;
  readonly code: SecretProviderResolutionCode;
  readonly source: SecretRefSource;
  readonly provider: string;

  constructor(params: {
    code: SecretProviderResolutionCode;
    source: SecretRefSource;
    provider: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "SecretProviderResolutionError";
    this.code = params.code;
    this.source = params.source;
    this.provider = params.provider;
  }
}

/** Error for failures limited to one SecretRef id under a provider. */
class SecretRefResolutionError extends Error {
  readonly scope = "ref" as const;
  readonly code: SecretRefResolutionCode;
  readonly source: SecretRefSource;
  readonly provider: string;
  readonly refId: string;

  constructor(params: {
    code: SecretRefResolutionCode;
    source: SecretRefSource;
    provider: string;
    refId: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "SecretRefResolutionError";
    this.code = params.code;
    this.source = params.source;
    this.provider = params.provider;
    this.refId = params.refId;
  }
}

/** Type guard for provider-scoped secret resolution failures. */
export function isProviderScopedSecretResolutionError(
  value: unknown,
): value is SecretProviderResolutionError {
  return value instanceof SecretProviderResolutionError;
}

export function isSecretResolutionError(
  value: unknown,
): value is SecretProviderResolutionError | SecretRefResolutionError {
  return (
    value instanceof SecretProviderResolutionError || value instanceof SecretRefResolutionError
  );
}

/** Redacted reason suitable for warnings and status output. */
export function describeSecretResolutionError(
  value: unknown,
): SecretResolutionFailureReason | undefined {
  if (value instanceof SecretProviderResolutionError) {
    return value.code === "SECRET_PROVIDER_UNAVAILABLE" ? "secret provider failed" : undefined;
  }
  if (!(value instanceof SecretRefResolutionError)) {
    return undefined;
  }
  switch (value.code) {
    case "SECRET_REF_NOT_FOUND":
      return "secret reference was not found";
    case "SECRET_REF_POLICY_DENIED":
      return "secret provider policy denied resolution";
    case "SECRET_REF_PROVIDER_ERROR":
      return "secret provider failed";
    case "SECRET_REF_PROVIDER_CONTRACT":
      return "secret provider response violated its contract";
    case "SECRET_REF_INVALID":
      return undefined;
  }
  return undefined;
}

export function providerResolutionError(params: {
  code?: SecretProviderResolutionCode;
  source: SecretRefSource;
  provider: string;
  message: string;
  cause?: unknown;
}): SecretProviderResolutionError {
  return new SecretProviderResolutionError({
    ...params,
    code: params.code ?? "SECRET_PROVIDER_UNAVAILABLE",
  });
}

export function refResolutionError(params: {
  code: SecretRefResolutionCode;
  source: SecretRefSource;
  provider: string;
  refId: string;
  message: string;
  cause?: unknown;
}): SecretRefResolutionError {
  return new SecretRefResolutionError(params);
}

/** Returns whether one SecretRef failed because its configured value is absent. */
export function isMissingSecretRefResolutionError(params: {
  ref: SecretRef;
  error: unknown;
}): boolean {
  const refId = params.ref.id.trim();
  // Canonical refs already own their provider identity. Config defaults only fill an omitted
  // provider during coercion; resolution never rewrites an explicit provider such as "default".
  return (
    params.error instanceof SecretRefResolutionError &&
    params.error.code === "SECRET_REF_NOT_FOUND" &&
    params.error.source === params.ref.source &&
    params.error.provider === params.ref.provider &&
    params.error.refId === refId
  );
}
