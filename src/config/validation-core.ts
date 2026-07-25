import path from "node:path";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  listAgentEntries,
  listAgentEntriesWithSource,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWindowsAbsolutePath,
} from "../shared/avatar-policy.js";
import {
  formatUnsafeGatewayTailscaleNoAuthMessage,
  isUnsafeGatewayTailscaleNoAuth,
} from "../shared/gateway-tailscale-auth-policy.js";
import { isRecord } from "../utils.js";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { materializeRuntimeConfig } from "./materialize.js";
import {
  isModelPolicyCompatSelector,
  isValidExactModelPolicyRef,
  parseModelPolicyWildcardRef,
} from "./model-policy-ref.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { collectRawBundledChannelConfigIssues } from "./validation-channel-rules.js";
import {
  collectUnsupportedSecretRefPolicyIssues,
  mapZodIssueToConfigIssue,
  mergeUnsupportedMutableSecretRefIssues,
  withConfigIssuePath,
} from "./validation-issues.js";
import { isBuiltInModelProviderOverlayId } from "./zod-schema.core.js";
import { OpenClawSchema } from "./zod-schema.js";

function materializeBundledModelProviderOverlays(config: OpenClawConfig): OpenClawConfig {
  const providers = config.models?.providers;
  if (!providers) {
    return config;
  }
  let nextProviders: typeof providers | undefined;
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (
      !isBuiltInModelProviderOverlayId(providerId) ||
      (providerConfig.baseUrl && Array.isArray(providerConfig.models))
    ) {
      continue;
    }
    nextProviders ??= { ...providers };
    nextProviders[providerId] = {
      ...providerConfig,
      baseUrl: providerConfig.baseUrl ?? "",
      models: providerConfig.models ?? [],
    };
  }
  return nextProviders
    ? { ...config, models: { ...config.models, providers: nextProviders } }
    : config;
}

function stripPreservedLegacyRootKeysForValidation(
  raw: unknown,
  keys?: readonly string[],
): unknown {
  if (!keys || keys.length === 0 || !isRecord(raw)) {
    return raw;
  }
  const next = { ...raw };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function isWorkspaceAvatarPath(value: string, workspaceDir: string): boolean {
  const workspaceRoot = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceRoot, value);
  return isPathWithinRoot(workspaceRoot, resolved);
}

function createIdentityAvatarIssue(
  source: ReturnType<typeof listAgentEntriesWithSource>[number]["source"],
  message: string,
): ConfigValidationIssue {
  const pathSegments =
    source.kind === "entries"
      ? (["agents", "entries", source.key, "identity", "avatar"] as const)
      : (["agents", "list", source.index, "identity", "avatar"] as const);
  return withConfigIssuePath({ path: pathSegments.join("."), message }, pathSegments);
}

function validateIdentityAvatar(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): ConfigValidationIssue[] {
  const agents = listAgentEntriesWithSource(config);
  if (agents.length === 0) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const { entry, source } of agents) {
    const avatarRaw = entry.identity?.avatar;
    if (typeof avatarRaw !== "string") {
      continue;
    }
    const avatar = avatarRaw.trim();
    if (!avatar || isAvatarDataUrl(avatar) || isAvatarHttpUrl(avatar)) {
      continue;
    }
    if (avatar.startsWith("~")) {
      issues.push(
        createIdentityAvatarIssue(
          source,
          "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
        ),
      );
      continue;
    }
    if (hasAvatarUriScheme(avatar) && !isWindowsAbsolutePath(avatar)) {
      issues.push(
        createIdentityAvatarIssue(
          source,
          "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
        ),
      );
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(
      config,
      entry.id ?? resolveDefaultAgentId(config),
      env,
    );
    if (!isWorkspaceAvatarPath(avatar, workspaceDir)) {
      issues.push(
        createIdentityAvatarIssue(source, "identity.avatar must stay within the agent workspace."),
      );
    }
  }
  return issues;
}

function validateGatewayTailscaleBind(config: OpenClawConfig): ConfigValidationIssue[] {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode !== "serve" && tailscaleMode !== "funnel") {
    return [];
  }
  const bindMode = config.gateway?.bind ?? "loopback";
  if (bindMode === "loopback") {
    return [];
  }
  const customBindHost = config.gateway?.customBindHost;
  if (
    bindMode === "custom" &&
    isCanonicalDottedDecimalIPv4(customBindHost) &&
    isLoopbackIpAddress(customBindHost)
  ) {
    return [];
  }
  return [
    {
      path: "gateway.bind",
      message:
        `gateway.bind must resolve to loopback when gateway.tailscale.mode=${tailscaleMode} ` +
        '(use gateway.bind="loopback" or gateway.bind="custom" with gateway.customBindHost="127.0.0.1")',
    },
  ];
}

function validateGatewayTailscaleAuth(config: OpenClawConfig): ConfigValidationIssue[] {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  if (!isUnsafeGatewayTailscaleNoAuth({ authMode: config.gateway?.auth?.mode, tailscaleMode })) {
    return [];
  }
  return [
    {
      path: "gateway.auth.mode",
      message: formatUnsafeGatewayTailscaleNoAuthMessage(tailscaleMode),
    },
  ];
}

function collectModelPolicyAllowIssues(config: OpenClawConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const defaultModels = config.agents?.defaults?.models;
  const collectAliases = (...modelMaps: Array<typeof defaultModels | undefined>): Set<string> => {
    const aliases = new Set<string>();
    for (const models of modelMaps) {
      for (const entry of Object.values(models ?? {})) {
        const alias = normalizeLowercaseStringOrEmpty(entry?.alias);
        if (alias) {
          aliases.add(alias);
        }
      }
    }
    return aliases;
  };
  const validateRefs = (
    refs: readonly string[] | undefined,
    configPath: string,
    aliases: Set<string>,
  ) => {
    for (const [index, raw] of (refs ?? []).entries()) {
      const trimmed = raw.trim();
      if (
        aliases.has(normalizeLowercaseStringOrEmpty(trimmed)) ||
        isModelPolicyCompatSelector(trimmed) ||
        isValidExactModelPolicyRef(trimmed) ||
        parseModelPolicyWildcardRef(trimmed)
      ) {
        continue;
      }
      issues.push({
        path: `${configPath}.${index}`,
        message:
          `invalid model policy ref: ${sanitizeForLog(JSON.stringify(raw))}. ` +
          'Use a configured alias, an exact "provider/model" ref, or a trailing prefix wildcard such as "provider/*" or "provider/namespace/*".',
      });
    }
  };

  const defaultAliases = collectAliases(defaultModels);
  validateRefs(
    config.agents?.defaults?.modelPolicy?.allow,
    "agents.defaults.modelPolicy.allow",
    defaultAliases,
  );
  for (const { entry: agent, source } of listAgentEntriesWithSource(config)) {
    const pathPrefix =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    validateRefs(
      agent.modelPolicy?.allow,
      `${pathPrefix}.modelPolicy.allow`,
      collectAliases(defaultModels, agent.models),
    );
  }
  return issues;
}

function attachAgentListProjection(config: OpenClawConfig): OpenClawConfig {
  if (!config.agents) {
    return config;
  }
  Object.defineProperty(config.agents, "list", {
    configurable: true,
    enumerable: false,
    value: listAgentEntries(config),
    writable: false,
  });
  return config;
}

/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export function validateConfigObjectRaw(
  raw: unknown,
  opts?: {
    sourceRaw?: unknown;
    touchedPaths?: ReadonlyArray<ReadonlyArray<string>>;
    validateBundledChannels?: boolean;
    preservedLegacyRootKeys?: readonly string[];
    env?: NodeJS.ProcessEnv;
  },
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const normalizedRaw = stripPreservedLegacyRootKeysForValidation(
    raw,
    opts?.preservedLegacyRootKeys,
  );
  const policyIssues = collectUnsupportedSecretRefPolicyIssues(normalizedRaw);
  const validated = OpenClawSchema.safeParse(normalizedRaw);
  if (!validated.success) {
    const schemaIssues = validated.error.issues.map(mapZodIssueToConfigIssue);
    return {
      ok: false,
      issues: mergeUnsupportedMutableSecretRefIssues(policyIssues, schemaIssues),
    };
  }
  const validatedConfig = attachAgentListProjection(
    materializeBundledModelProviderOverlays(validated.data as OpenClawConfig),
  );
  const channelIssues =
    policyIssues.length > 0 || opts?.validateBundledChannels
      ? collectRawBundledChannelConfigIssues(validatedConfig)
      : [];
  if (channelIssues.length > 0) {
    return {
      ok: false,
      issues: mergeUnsupportedMutableSecretRefIssues(policyIssues, channelIssues),
    };
  }
  if (policyIssues.length > 0) {
    return { ok: false, issues: policyIssues };
  }
  const duplicates = findDuplicateAgentDirs(validatedConfig);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: [{ path: "agents.entries", message: formatDuplicateAgentDirError(duplicates) }],
    };
  }
  const avatarIssues = validateIdentityAvatar(validatedConfig, opts?.env);
  if (avatarIssues.length > 0) {
    return { ok: false, issues: avatarIssues };
  }
  const gatewayTailscaleBindIssues = validateGatewayTailscaleBind(validatedConfig);
  if (gatewayTailscaleBindIssues.length > 0) {
    return { ok: false, issues: gatewayTailscaleBindIssues };
  }
  const gatewayTailscaleAuthIssues = validateGatewayTailscaleAuth(validatedConfig);
  if (gatewayTailscaleAuthIssues.length > 0) {
    return { ok: false, issues: gatewayTailscaleAuthIssues };
  }
  const modelPolicyAllowIssues = collectModelPolicyAllowIssues(validatedConfig);
  if (modelPolicyAllowIssues.length > 0) {
    return { ok: false, issues: modelPolicyAllowIssues };
  }
  return { ok: true, config: validatedConfig };
}

export function validateConfigObject(
  raw: unknown,
  opts?: {
    manifestRegistry?: Pick<PluginMetadataSnapshot, "manifestRegistry">["manifestRegistry"];
    sourceRaw?: unknown;
  },
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const result = validateConfigObjectRaw(migratePersistedImplicitMainRoster(raw).config, opts);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    config: attachAgentListProjection(
      materializeRuntimeConfig(result.config, "snapshot", {
        manifestRegistry: opts?.manifestRegistry,
      }),
    ),
  };
}
