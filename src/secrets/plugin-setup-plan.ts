/** Shared plan construction for plugin-owned SecretRef setup commands. */
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type { PluginIntegrationSecretProviderConfig, SecretRef } from "../config/types.secrets.js";
import type { SecretsApplyPlan, SecretsPlanTarget } from "./plan.js";
import { resolveSecretPlanTargetByPath } from "./target-registry-query.js";

type PluginSecretRefProviderMapping = {
  providerId: string;
  secretId: string;
};

type PluginSecretRefConfigTargetMapping = {
  path: string;
  agentId?: string;
  secretId: string;
};

const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function parseDotPath(pathname: string): string[] {
  return pathname
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function toDotPath(segments: string[]): string {
  return segments.join(".");
}

export function assertValidPluginSecretProviderAlias(value: string): void {
  if (!SECRET_PROVIDER_ALIAS_PATTERN.test(value)) {
    throw new Error(
      `Invalid provider alias "${value}". Use lowercase letters, numbers, underscores, or hyphens.`,
    );
  }
}

export function assertValidPluginModelProviderId(label: string, value: string): void {
  if (!MODEL_PROVIDER_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} model provider id: ${value}`);
  }
}

export function parsePluginSecretTargetSpecifier(
  productName: string,
  value: string,
): { path: string; agentId?: string } {
  if (!value.startsWith("auth-profiles:")) {
    return {
      path: value.startsWith("openclaw:") ? value.slice("openclaw:".length) : value,
    };
  }
  const remainder = value.slice("auth-profiles:".length);
  const separatorIndex = remainder.indexOf(":");
  const agentId = separatorIndex >= 0 ? remainder.slice(0, separatorIndex) : "";
  const targetPath = separatorIndex >= 0 ? remainder.slice(separatorIndex + 1) : "";
  if (!isValidAgentId(agentId) || !targetPath) {
    throw new Error(`Invalid --target auth-profiles target for ${productName}: ${value}`);
  }
  return { agentId, path: targetPath };
}

function createPluginModelApiKeyTarget(params: {
  providerAlias: string;
  providerId: string;
  secretId: string;
}): SecretsPlanTarget {
  assertValidPluginModelProviderId("target", params.providerId);
  return {
    type: "models.providers.apiKey",
    path: `models.providers.${params.providerId}.apiKey`,
    pathSegments: ["models", "providers", params.providerId, "apiKey"],
    providerId: params.providerId,
    ref: {
      source: "exec",
      provider: params.providerAlias,
      id: params.secretId,
    },
  };
}

function createPluginConfigSecretTarget(params: {
  productName: string;
  providerAlias: string;
  path: string;
  agentId?: string;
  secretId: string;
}): SecretsPlanTarget {
  if (params.agentId && !isValidAgentId(params.agentId)) {
    throw new Error(`Invalid ${params.productName} setup agent id: ${params.agentId}`);
  }
  const pathSegments = parseDotPath(params.path);
  const normalizedPath = toDotPath(pathSegments);
  if (
    pathSegments.length === 0 ||
    normalizedPath !== params.path ||
    pathSegments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))
  ) {
    throw new Error(`Invalid --target config path: ${params.path}`);
  }
  const resolved = resolveSecretPlanTargetByPath({
    configFile: params.agentId ? "auth-profiles.json" : "openclaw.json",
    pathSegments,
  });
  if (!resolved) {
    throw new Error(
      `Unknown or unsupported ${params.productName} setup target path: ${params.path}`,
    );
  }
  const ref: SecretRef = {
    source: "exec",
    provider: params.providerAlias,
    id: params.secretId,
  };
  return {
    type: resolved.entry.targetType,
    path: normalizedPath,
    pathSegments,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ref,
  };
}

export function buildPluginSecretRefSetupPlan(params: {
  productName: string;
  providerAlias: string;
  providerConfig: PluginIntegrationSecretProviderConfig;
  providerSecrets: PluginSecretRefProviderMapping[];
  configTargetSecrets?: PluginSecretRefConfigTargetMapping[];
  generatedAt?: string;
}): SecretsApplyPlan & {
  providerUpserts: Record<string, PluginIntegrationSecretProviderConfig>;
} {
  assertValidPluginSecretProviderAlias(params.providerAlias);
  const targets = [
    ...params.providerSecrets.map((entry) =>
      createPluginModelApiKeyTarget({
        providerAlias: params.providerAlias,
        providerId: entry.providerId,
        secretId: entry.secretId,
      }),
    ),
    ...(params.configTargetSecrets ?? []).map((entry) =>
      createPluginConfigSecretTarget({
        productName: params.productName,
        providerAlias: params.providerAlias,
        path: entry.path,
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        secretId: entry.secretId,
      }),
    ),
  ];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = target.agentId
      ? `auth-profiles:${target.agentId}:${target.path}`
      : `openclaw:${target.path}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate secret target path in ${params.productName} setup: ${target.path}`,
      );
    }
    seen.add(key);
  }
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    generatedBy: "manual",
    providerUpserts: {
      [params.providerAlias]: params.providerConfig,
    },
    targets,
  };
}
