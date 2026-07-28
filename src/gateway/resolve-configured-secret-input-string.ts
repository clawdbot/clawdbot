// SecretRef-aware Gateway config string resolver.
// Resolves configured secret inputs and fallback values without leaking values.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";

export type SecretInputUnresolvedReasonStyle = "generic" | "detailed"; // pragma: allowlist secret
type ConfiguredSecretInputSource =
  | "config"
  | "secretRef" // pragma: allowlist secret
  | "fallback";

function buildUnresolvedReason(params: {
  path: string;
  style: SecretInputUnresolvedReasonStyle;
  kind: "unresolved" | "non-string" | "empty";
  refLabel: string;
}): string {
  if (params.style === "generic") {
    return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
  }
  if (params.kind === "non-string") {
    return `${params.path} SecretRef resolved to a non-string value.`;
  }
  if (params.kind === "empty") {
    return `${params.path} SecretRef resolved to an empty value.`;
  }
  return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
}

export async function resolveConfiguredSecretInputString(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{ value?: string; unresolvedRefReason?: string }> {
  const style = params.unresolvedReasonStyle ?? "generic";
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.config.secrets?.defaults,
  });
  if (!ref) {
    return { value: normalizeOptionalString(params.value) };
  }

  const refLabel = `${ref.source}:${ref.provider}:${ref.id}`;
  try {
    const resolved = await resolveSecretRefValues([ref], {
      config: params.config,
      env: params.env,
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    });
    const resolvedValue = resolved.get(secretRefKey(ref));
    if (typeof resolvedValue !== "string") {
      return {
        unresolvedRefReason: buildUnresolvedReason({
          path: params.path,
          style,
          kind: "non-string",
          refLabel,
        }),
      };
    }
    const trimmed = normalizeOptionalString(resolvedValue);
    if (!trimmed) {
      return {
        unresolvedRefReason: buildUnresolvedReason({
          path: params.path,
          style,
          kind: "empty",
          refLabel,
        }),
      };
    }
    return { value: trimmed };
  } catch {
    return {
      unresolvedRefReason: buildUnresolvedReason({
        path: params.path,
        style,
        kind: "unresolved",
        refLabel,
      }),
    };
  }
}

async function resolveConfiguredSecretRefOnlyInputString(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{ refConfigured: boolean; value?: string; unresolvedRefReason?: string }> {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.config.secrets?.defaults,
  });
  if (!ref) {
    return { refConfigured: false };
  }
  return {
    refConfigured: true,
    ...(await resolveConfiguredSecretInputString({
      config: params.config,
      env: params.env,
      value: params.value,
      path: params.path,
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
      unresolvedReasonStyle: params.unresolvedReasonStyle,
    })),
  };
}

export async function resolveConfiguredSecretInputWithFallback(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
  readFallback?: () => string | undefined;
}): Promise<{
  value?: string;
  source?: ConfiguredSecretInputSource;
  unresolvedRefReason?: string;
  secretRefConfigured: boolean;
}> {
  const resolved = await resolveConfiguredSecretRefOnlyInputString(params);
  const readNormalizedFallback = () => normalizeOptionalString(params.readFallback?.());
  const configValue = !resolved.refConfigured ? normalizeOptionalString(params.value) : undefined;
  if (configValue) {
    return {
      value: configValue,
      source: "config",
      secretRefConfigured: false,
    };
  }
  if (!resolved.refConfigured) {
    const fallback = readNormalizedFallback();
    if (fallback) {
      // Fallbacks are only returned after direct config is absent, preserving
      // explicit config precedence while still allowing credential stores.
      return {
        value: fallback,
        source: "fallback",
        secretRefConfigured: false,
      };
    }
    return { secretRefConfigured: false };
  }

  if (resolved.value) {
    return {
      value: resolved.value,
      source: "secretRef",
      secretRefConfigured: true,
    };
  }

  const fallback = readNormalizedFallback();
  if (fallback) {
    // An unresolved SecretRef does not block fallback credentials. Callers get
    // both the source and secretRefConfigured flag for warning policy.
    return {
      value: fallback,
      source: "fallback",
      secretRefConfigured: true,
    };
  }

  return {
    unresolvedRefReason: resolved.unresolvedRefReason,
    secretRefConfigured: true,
  };
}

export async function resolveRequiredConfiguredSecretRefInputString(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<string | undefined> {
  const resolved = await resolveConfiguredSecretRefOnlyInputString(params);
  if (!resolved.refConfigured) {
    return undefined;
  }
  if (resolved.value) {
    return resolved.value;
  }
  throw new Error(resolved.unresolvedRefReason ?? `${params.path} resolved to an empty value.`);
}
