import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputString } from "../config/types.secrets.js";
import { canResolveEnvSecretRefInReadOnlyPath } from "./secret-ref-readonly.internal.js";

export { canResolveEnvSecretRefInReadOnlyPath } from "./secret-ref-readonly.internal.js";

export type ReadOnlyEnvSecretRefResolution =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "blocked" };

/** Resolve one configured secret without letting blocked refs borrow ambient credentials. */
export function resolveReadOnlyEnvSecretRef(params: {
  value: unknown;
  path: string;
  cfg?: OpenClawConfig;
  expectedEnvId: string;
  normalizeValue: (value: unknown) => string | undefined;
}): ReadOnlyEnvSecretRefResolution {
  const resolved = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const normalized = params.normalizeValue(resolved.value);
    return normalized ? { status: "available", value: normalized } : { status: "missing" };
  }
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  if (resolved.ref.source !== "env") {
    return { status: "blocked" };
  }
  const envId = resolved.ref.id.trim();
  if (envId !== params.expectedEnvId) {
    return { status: "blocked" };
  }
  if (
    !canResolveEnvSecretRefInReadOnlyPath({
      cfg: params.cfg,
      provider: resolved.ref.provider,
      id: envId,
    })
  ) {
    return { status: "blocked" };
  }
  const envValue = params.normalizeValue(process.env[envId]);
  return envValue ? { status: "available", value: envValue } : { status: "missing" };
}
