import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { CHANNEL_IDS, normalizeChatChannelId } from "../channels/ids.js";
import { withBundledPluginAllowlistCompat } from "../plugins/bundled-compat.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import {
  collectRelevantDoctorPluginIds,
  collectRelevantDoctorPluginIdsForTouchedPaths,
  listPluginDoctorLegacyConfigRules,
} from "../plugins/doctor-contract-registry.js";
import { resolveManifestCommandAliasOwner } from "../plugins/manifest-command-aliases.runtime.js";
import {
  loadPluginManifestRegistry,
  resolveManifestContractPluginIds,
} from "../plugins/manifest-registry.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { hasKind } from "../plugins/slots.js";
import { collectUnsupportedSecretRefConfigCandidates } from "../secrets/unsupported-surface-policy.js";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWindowsAbsolutePath,
} from "../shared/avatar-policy.js";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "../shared/net/ip.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "./allowed-values.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { collectChannelSchemaMetadata } from "./channel-config-metadata.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig, ConfigValidationIssue } from "./types.js";
import { coerceSecretRef } from "./types.secrets.js";
import { OpenClawSchema } from "./zod-schema.js";

const LEGACY_REMOVED_PLUGIN_IDS = new Set(["google-antigravity-auth", "google-gemini-cli-auth"]);

type UnknownIssueRecord = Record<string, unknown>;
type ConfigPathSegment = string | number;
type AllowedValuesCollection = {
  values: unknown[];
  incomplete: boolean;
  hasValues: boolean;
};
type JsonSchemaLike = Record<string, unknown>;

const CUSTOM_EXPECTED_ONE_OF_RE = /expected one of ((?:"[^"]+"(?:\|"?[^"]+"?)*)+)/i;
const SECRETREF_POLICY_DOC_URL = "https://docs.openclaw.ai/reference/secretref-credential-surface";
const bundledChannelSchemaById = new Map<string, unknown>(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map(
    (entry) => [entry.channelId, entry.schema] as const,
  ),
);

function toIssueRecord(value: unknown): UnknownIssueRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownIssueRecord;
}

function toConfigPathSegments(path: unknown): ConfigPathSegment[] {
  if (!Array.isArray(path)) {
    return [];
  }
  return path.filter((segment): segment is ConfigPathSegment => {
    const segmentType = typeof segment;
    return segmentType === "string" || segmentType === "number";
  });
}

function formatConfigPath(segments: readonly ConfigPathSegment[]): string {
  return segments.join(".");
}

function asJsonSchemaLike(value: unknown): JsonSchemaLike | null {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : null;
}

function lookupJsonSchemaNode(
  schema: unknown,
  pathSegments: readonly ConfigPathSegment[],
): JsonSchemaLike | null {
  let current = asJsonSchemaLike(schema);
  for (const segment of pathSegments) {
    if (!current) {
      return null;
    }
    if (typeof segment === "number") {
      const items = current.items;
      if (Array.isArray(items)) {
        current = asJsonSchemaLike(items[segment] ?? items[0]);
        continue;
      }
      current = asJsonSchemaLike(items);
      continue;
    }
    const properties = asJsonSchemaLike(current.properties);
    const next =
      (properties && asJsonSchemaLike(properties[segment])) ||
      asJsonSchemaLike(current.additionalProperties);
    current = next;
  }
  return current;
}

function collectAllowedValuesFromJsonSchemaNode(schema: unknown): AllowedValuesCollection {
  const node = asJsonSchemaLike(schema);
  if (!node) {
    return { values: [], incomplete: false, hasValues: false };
  }

  if (Object.prototype.hasOwnProperty.call(node, "const")) {
    return { values: [node.const], incomplete: false, hasValues: true };
  }

  if (Array.isArray(node.enum)) {
    return { values: node.enum, incomplete: false, hasValues: node.enum.length > 0 };
  }

  const type = node.type;
  if (type === "boolean") {
    return { values: [true, false], incomplete: false, hasValues: true };
  }
  if (Array.isArray(type) && type.includes("boolean")) {
    return { values: [true, false], incomplete: false, hasValues: true };
  }

  const unionBranches = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null;
  if (!unionBranches) {
    return { values: [], incomplete: false, hasValues: false };
  }

  const collected: unknown[] = [];
  for (const branch of unionBranches) {
    const branchCollected = collectAllowedValuesFromJsonSchemaNode(branch);
    if (branchCollected.incomplete || !branchCollected.hasValues) {
      return { values: [], incomplete: true, hasValues: false };
    }
    collected.push(...branchCollected.values);
  }

  return { values: collected, incomplete: false, hasValues: collected.length > 0 };
}

function collectAllowedValuesFromBundledChannelSchemaPath(
  pathSegments: readonly ConfigPathSegment[],
): AllowedValuesCollection {
  if (pathSegments[0] !== "channels" || typeof pathSegments[1] !== "string") {
    return { values: [], incomplete: false, hasValues: false };
  }
  const channelSchema = bundledChannelSchemaById.get(pathSegments[1]);
  if (!channelSchema) {
    return { values: [], incomplete: false, hasValues: false };
  }
  const targetNode = lookupJsonSchemaNode(channelSchema, pathSegments.slice(2));
  if (!targetNode) {
    return { values: [], incomplete: false, hasValues: false };
  }
  return collectAllowedValuesFromJsonSchemaNode(targetNode);
}

function collectAllowedValuesFromCustomIssue(record: UnknownIssueRecord): AllowedValuesCollection {
  const message = typeof record.message === "string" ? record.message : "";
  const expectedMatch = message.match(CUSTOM_EXPECTED_ONE_OF_RE);
  if (expectedMatch?.[1]) {
    const values = [...expectedMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    return { values, incomplete: false, hasValues: values.length > 0 };
  }

  // Custom Zod issues usually come from superRefine rules, but some normalized
  // channel unions collapse to a generic custom issue. Use generated channel
  // config metadata here so we can recover enum hints without touching runtime
  // plugin registries during validation formatting.
  return collectAllowedValuesFromBundledChannelSchemaPath(toConfigPathSegments(record.path));
}

function collectAllowedValuesFromIssue(issue: unknown): AllowedValuesCollection {
  const record = toIssueRecord(issue);
  if (!record) {
    return { values: [], incomplete: false, hasValues: false };
  }
  const code = typeof record.code === "string" ? record.code : "";

  if (code === "invalid_value") {
    const values = record.values;
    if (!Array.isArray(values)) {
      return { values: [], incomplete: true, hasValues: false };
    }
    return { values, incomplete: false, hasValues: values.length > 0 };
  }

  if (code === "invalid_type") {
    const expected = typeof record.expected === "string" ? record.expected : "";
    if (expected === "boolean") {
      return { values: [true, false], incomplete: false, hasValues: true };
    }
    return { values: [], incomplete: true, hasValues: false };
  }

  if (code === "custom") {
    return collectAllowedValuesFromCustomIssue(record);
  }

  if (code !== "invalid_union") {
    return { values: [], incomplete: false, hasValues: false };
  }

  const nested = record.errors;
  if (!Array.isArray(nested) || nested.length === 0) {
    return { values: [], incomplete: true, hasValues: false };
  }

  const collected: unknown[] = [];
  for (const branch of nested) {
    if (!Array.isArray(branch) || branch.length === 0) {
      return { values: [], incomplete: true, hasValues: false };
    }
    const branchCollected = collectAllowedValuesFromIssueList(branch);
    if (branchCollected.incomplete || !branchCollected.hasValues) {
      return { values: [], incomplete: true, hasValues: false };
    }
    collected.push(...branchCollected.values);
  }

  return { values: collected, incomplete: false, hasValues: collected.length > 0 };
}

function collectAllowedValuesFromIssueList(
  issues: ReadonlyArray<unknown>,
): AllowedValuesCollection {
  const collected: unknown[] = [];
  let hasValues = false;
  for (const issue of issues) {
    const branch = collectAllowedValuesFromIssue(issue);
    if (branch.incomplete) {
      return { values: [], incomplete: true, hasValues: false };
    }
    if (!branch.hasValues) {
      continue;
    }
    hasValues = true;
    collected.push(...branch.values);
  }
  return { values: collected, incomplete: false, hasValues };
}

function collectAllowedValuesFromUnknownIssue(issue: unknown): unknown[] {
  const collection = collectAllowedValuesFromIssue(issue);
  if (collection.incomplete || !collection.hasValues) {
    return [];
  }
  return collection.values;
}

function isBindingsIssuePath(pathSegments: readonly ConfigPathSegment[]): boolean {
  return pathSegments[0] === "bindings" && typeof pathSegments[1] === "number";
}

function isRouteTypeMismatchIssue(issue: UnknownIssueRecord): boolean {
  const issuePath = toConfigPathSegments(issue.path);
  if (issuePath.length !== 1 || issuePath[0] !== "type") {
    return false;
  }
  if (issue.code !== "invalid_value" || !Array.isArray(issue.values)) {
    return false;
  }
  return issue.values.includes("route");
}

function extractBindingsSpecificUnionIssue(
  record: UnknownIssueRecord,
  parentPath: string,
): ConfigValidationIssue | null {
  if (!isBindingsIssuePath(toConfigPathSegments(record.path)) || !Array.isArray(record.errors)) {
    return null;
  }

  let matchingBranchIssue: UnknownIssueRecord | null = null;
  let matchingBranchIsUnrecognized = false;
  let matchingBranchPathLen = -1;
  let sawRouteTypeMismatch = false;

  for (const errGroup of record.errors) {
    if (!Array.isArray(errGroup)) {
      continue;
    }

    const branch = errGroup
      .map((issue) => toIssueRecord(issue))
      .filter(Boolean) as UnknownIssueRecord[];
    if (branch.length === 0) {
      continue;
    }

    if (branch.some((issue) => isRouteTypeMismatchIssue(issue))) {
      sawRouteTypeMismatch = true;
      continue;
    }

    let branchBestIssue: UnknownIssueRecord | null = null;
    let branchBestIsUnrecognized = false;
    let branchBestPathLen = -1;

    for (const issue of branch) {
      const issueCode = typeof issue.code === "string" ? issue.code : "";
      const issuePathLen = toConfigPathSegments(issue.path).length;
      const issueIsUnrecognized = issueCode === "unrecognized_keys";
      const issueIsBetter =
        issuePathLen > branchBestPathLen
          ? true
          : issuePathLen === branchBestPathLen && issueIsUnrecognized && !branchBestIsUnrecognized;

      if (issueIsBetter) {
        branchBestIssue = issue;
        branchBestIsUnrecognized = issueIsUnrecognized;
        branchBestPathLen = issuePathLen;
      }
    }

    if (!branchBestIssue) {
      continue;
    }

    if (matchingBranchIssue) {
      return null;
    }

    matchingBranchIssue = branchBestIssue;
    matchingBranchIsUnrecognized = branchBestIsUnrecognized;
    matchingBranchPathLen = branchBestPathLen;
  }

  if (!sawRouteTypeMismatch || !matchingBranchIssue) {
    return null;
  }

  if (matchingBranchPathLen === 0 && !matchingBranchIsUnrecognized) {
    return null;
  }

  const subPath = formatConfigPath(toConfigPathSegments(matchingBranchIssue.path));
  const fullPath = parentPath && subPath ? `${parentPath}.${subPath}` : parentPath || subPath;
  const subMessage =
    typeof matchingBranchIssue.message === "string" ? matchingBranchIssue.message : "Invalid input";
  return { path: fullPath, message: subMessage };
}

function isObjectSecretRefCandidate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return coerceSecretRef(value) !== null;
}

function formatUnsupportedMutableSecretRefMessage(path: string): string {
  return [
    `SecretRef objects are not supported at ${path}.`,
    "This credential is runtime-mutable or runtime-managed and must stay a plain string value.",
    'Use a plain string (env template strings like "${MY_VAR}" are allowed).',
    `See ${SECRETREF_POLICY_DOC_URL}.`,
  ].join(" ");
}

function pushUnsupportedMutableSecretRefIssue(
  issues: ConfigValidationIssue[],
  path: string,
  value: unknown,
): void {
  if (!isObjectSecretRefCandidate(value)) {
    return;
  }
  issues.push({
    path,
    message: formatUnsupportedMutableSecretRefMessage(path),
  });
}

function collectUnsupportedMutableSecretRefIssues(raw: unknown): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const candidate of collectUnsupportedSecretRefConfigCandidates(raw)) {
    pushUnsupportedMutableSecretRefIssue(issues, candidate.path, candidate.value);
  }

  return issues;
}

function isUnsupportedMutableSecretRefSchemaIssue(params: {
  issue: ConfigValidationIssue;
  policyIssue: ConfigValidationIssue;
}): boolean {
  const { issue, policyIssue } = params;
  if (issue.path === policyIssue.path) {
    return /expected string, received object/i.test(issue.message);
  }

  if (!issue.path || !policyIssue.path || !policyIssue.path.startsWith(`${issue.path}.`)) {
    return false;
  }

  const remainder = policyIssue.path.slice(issue.path.length + 1);
  const childKey = remainder.split(".")[0];
  if (!childKey) {
    return false;
  }

  if (!/Unrecognized key/i.test(issue.message)) {
    return false;
  }
  const unrecognizedKeys = [...issue.message.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (unrecognizedKeys.length === 0) {
    return false;
  }
  return unrecognizedKeys.length === 1 && unrecognizedKeys[0] === childKey;
}

function mergeUnsupportedMutableSecretRefIssues(
  policyIssues: ConfigValidationIssue[],
  schemaIssues: ConfigValidationIssue[],
): ConfigValidationIssue[] {
  if (policyIssues.length === 0) {
    return schemaIssues;
  }
  const filteredSchemaIssues = schemaIssues.filter(
    (issue) =>
      !policyIssues.some((policyIssue) =>
        isUnsupportedMutableSecretRefSchemaIssue({ issue, policyIssue }),
      ),
  );
  return [...policyIssues, ...filteredSchemaIssues];
}

export function collectUnsupportedSecretRefPolicyIssues(raw: unknown): ConfigValidationIssue[] {
  return collectUnsupportedMutableSecretRefIssues(raw);
}

function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue {
  const record = toIssueRecord(issue);
  const path = formatConfigPath(toConfigPathSegments(record?.path));
  const message = typeof record?.message === "string" ? record.message : "Invalid input";

  const allowedValuesSummary = summarizeAllowedValues(collectAllowedValuesFromUnknownIssue(issue));

  // Bindings use a plain union because legacy route bindings may omit `type`.
  // When an explicit ACP binding fails strict-object checks, Zod collapses the
  // useful ACP branch issue behind a generic union-level "Invalid input".
  if (
    record &&
    typeof record.code === "string" &&
    record.code === "invalid_union" &&
    !allowedValuesSummary
  ) {
    const betterIssue = extractBindingsSpecificUnionIssue(record, path);
    if (betterIssue) {
      return betterIssue;
    }
  }

  if (!allowedValuesSummary) {
    return { path, message };
  }

  return {
    path,
    message: appendAllowedValuesHint(message, allowedValuesSummary),
    allowedValues: allowedValuesSummary.values,
    allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
  };
}

export const __testing = {
  mapZodIssueToConfigIssue,
};

function isWorkspaceAvatarPath(value: string, workspaceDir: string): boolean {
  const workspaceRoot = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceRoot, value);
  return isPathWithinRoot(workspaceRoot, resolved);
}

function validateIdentityAvatar(config: OpenClawConfig): ConfigValidationIssue[] {
  const agents = config.agents?.list;
  if (!Array.isArray(agents) || agents.length === 0) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const [index, entry] of agents.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const avatarRaw = entry.identity?.avatar;
    if (typeof avatarRaw !== "string") {
      continue;
    }
    const avatar = avatarRaw.trim();
    if (!avatar) {
      continue;
    }
    if (isAvatarDataUrl(avatar) || isAvatarHttpUrl(avatar)) {
      continue;
    }
    if (avatar.startsWith("~")) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const hasScheme = hasAvatarUriScheme(avatar);
    if (hasScheme && !isWindowsAbsolutePath(avatar)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(
      config,
      entry.id ?? resolveDefaultAgentId(config),
    );
    if (!isWorkspaceAvatarPath(avatar, workspaceDir)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must stay within the agent workspace.",
      });
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

/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export function validateConfigObjectRaw(
  raw: unknown,
  opts?: {
    touchedPaths?: ReadonlyArray<ReadonlyArray<string>>;
  },
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const policyIssues = collectUnsupportedSecretRefPolicyIssues(raw);
  const doctorPluginIds = opts?.touchedPaths
    ? collectRelevantDoctorPluginIdsForTouchedPaths({
        raw,
        touchedPaths: opts.touchedPaths,
      })
    : collectRelevantDoctorPluginIds(raw);
  const extraLegacyRules = listPluginDoctorLegacyConfigRules({
    pluginIds: doctorPluginIds,
  });
  const legacyIssues = findLegacyConfigIssues(raw, raw, extraLegacyRules, opts?.touchedPaths);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues.map((iss) => ({
        path: iss.path,
        message: iss.message,
      })),
    };
  }
  const validated = OpenClawSchema.safeParse(raw);
  if (!validated.success) {
    const schemaIssues = validated.error.issues.map((issue) => mapZodIssueToConfigIssue(issue));
    return {
      ok: false,
      issues: mergeUnsupportedMutableSecretRefIssues(policyIssues, schemaIssues),
    };
  }
  if (policyIssues.length > 0) {
    return { ok: false, issues: policyIssues };
  }
  const validatedConfig = validated.data as OpenClawConfig;
  const duplicates = findDuplicateAgentDirs(validatedConfig);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: [
        {
          path: "agents.list",
          message: formatDuplicateAgentDirError(duplicates),
        },
      ],
    };
  }
  const avatarIssues = validateIdentityAvatar(validatedConfig);
  if (avatarIssues.length > 0) {
    return { ok: false, issues: avatarIssues };
  }
  const gatewayTailscaleBindIssues = validateGatewayTailscaleBind(validatedConfig);
  if (gatewayTailscaleBindIssues.length > 0) {
    return { ok: false, issues: gatewayTailscaleBindIssues };
  }
  return {
    ok: true,
    config: validatedConfig,
  };
}

export function validateConfigObject(
  raw: unknown,
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const result = validateConfigObjectRaw(raw);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    config: materializeRuntimeConfig(result.config, "snapshot"),
  };
}

type ValidateConfigWithPluginsResult =
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    };

export function validateConfigObjectWithPlugins(
  raw: unknown,
  params?: { env?: NodeJS.ProcessEnv },
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: true, env: params?.env });
}

export function validateConfigObjectRawWithPlugins(
  raw: unknown,
  params?: { env?: NodeJS.ProcessEnv },
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: false, env: params?.env });
}

function validateConfigObjectWithPluginsBase(
  raw: unknown,
  opts: { applyDefaults: boolean; env?: NodeJS.ProcessEnv },
): ValidateConfigWithPluginsResult {
  const base = opts.applyDefaults ? validateConfigObject(raw) : validateConfigObjectRaw(raw);
  if (!base.ok) {
    return { ok: false, issues: base.issues, warnings: [] };
  }

  const config = base.config;
  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];
  const hasExplicitPluginsConfig =
    isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, "plugins");

  const resolvePluginConfigIssuePath = (pluginId: string, errorPath: string): string => {
    const base = `plugins.entries.${pluginId}.config`;
    if (!errorPath || errorPath === "<root>") {
      return base;
    }
    return `${base}.${errorPath}`;
  };

  type RegistryInfo = {
    registry: ReturnType<typeof loadPluginManifestRegistry>;
    knownIds?: Set<string>;
    overriddenPluginIds?: Set<string>;
    normalizedPlugins?: ReturnType<typeof normalizePluginsConfig>;
    channelSchemas?: Map<
      string,
      {
        schema?: Record<string, unknown>;
      }
    >;
  };

  let registryInfo: RegistryInfo | null = null;
  let compatConfig: OpenClawConfig | null | undefined;
  let compatPluginIds: ReadonlySet<string> | null = null;
  let compatPluginIdsResolved = false;

  const ensureCompatPluginIds = (): ReadonlySet<string> => {
    if (compatPluginIdsResolved) {
      return compatPluginIds ?? new Set<string>();
    }
    compatPluginIdsResolved = true;
    const allow = config.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      compatPluginIds = new Set<string>();
      return compatPluginIds;
    }
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const overriddenBundledPluginIds = new Set(
      loadPluginManifestRegistry({
        config,
        workspaceDir: workspaceDir ?? undefined,
        env: opts.env,
      })
        .diagnostics.filter((diag) => diag.message.includes("duplicate plugin id detected"))
        .map((diag) => diag.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== ""),
    );
    compatPluginIds = new Set(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        origin: "bundled",
        config,
        workspaceDir: workspaceDir ?? undefined,
        env: opts.env,
      }).filter((pluginId) => !overriddenBundledPluginIds.has(pluginId)),
    );
    return compatPluginIds;
  };

  const ensureCompatConfig = (): OpenClawConfig => {
    if (compatConfig !== undefined) {
      return compatConfig ?? config;
    }

    const allow = config.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      compatConfig = config;
      return config;
    }

    compatConfig = withBundledPluginAllowlistCompat({
      config,
      pluginIds: [...ensureCompatPluginIds()],
    });
    return compatConfig ?? config;
  };

  const ensureRegistry = (): RegistryInfo => {
    if (registryInfo) {
      return registryInfo;
    }

    const effectiveConfig = ensureCompatConfig();
    const workspaceDir = resolveAgentWorkspaceDir(
      effectiveConfig,
      resolveDefaultAgentId(effectiveConfig),
    );
    const registry = loadPluginManifestRegistry({
      config: effectiveConfig,
      workspaceDir: workspaceDir ?? undefined,
      env: opts.env,
    });

    for (const diag of registry.diagnostics) {
      let path = diag.pluginId ? `plugins.entries.${diag.pluginId}` : "plugins";
      if (!diag.pluginId && diag.message.includes("plugin path not found")) {
        path = "plugins.load.paths";
      }
      const pluginLabel = diag.pluginId ? `plugin ${diag.pluginId}` : "plugin";
      const message = `${pluginLabel}: ${diag.message}`;
      if (diag.level === "error") {
        issues.push({ path, message });
      } else {
        warnings.push({ path, message });
      }
    }

    registryInfo = { registry };
    return registryInfo;
  };

  const ensureKnownIds = (): Set<string> => {
    const info = ensureRegistry();
    if (!info.knownIds) {
      info.knownIds = new Set(info.registry.plugins.map((record) => record.id));
    }
    return info.knownIds;
  };

  const ensureOverriddenPluginIds = (): Set<string> => {
    const info = ensureRegistry();
    if (!info.overriddenPluginIds) {
      info.overriddenPluginIds = new Set(
        info.registry.diagnostics
          .filter((diag) => diag.message.includes("duplicate plugin id detected"))
          .map((diag) => diag.pluginId)
          .filter(
            (pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== "",
          ),
      );
    }
    return info.overriddenPluginIds;
  };

  const ensureNormalizedPlugins = (): ReturnType<typeof normalizePluginsConfig> => {
    const info = ensureRegistry();
    if (!info.normalizedPlugins) {
      info.normalizedPlugins = normalizePluginsConfig(ensureCompatConfig().plugins);
    }
    return info.normalizedPlugins;
  };

  const ensureChannelSchemas = (): Map<
    string,
    {
      schema?: Record<string, unknown>;
    }
  > => {
    const info = ensureRegistry();
    if (!info.channelSchemas) {
      info.channelSchemas = new Map(
        GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map(
          (entry) => [entry.channelId, { schema: entry.schema }] as const,
        ),
      );
      for (const entry of collectChannelSchemaMetadata(info.registry)) {
        const current = info.channelSchemas.get(entry.id);
        if (entry.configSchema) {
          info.channelSchemas.set(entry.id, { schema: entry.configSchema });
          continue;
        }
        if (!current) {
          info.channelSchemas.set(entry.id, {});
        }
      }
    }
    return info.channelSchemas;
  };

  let mutatedConfig = config;
  let channelsCloned = false;
  let pluginsCloned = false;
  let pluginEntriesCloned = false;

  const replaceChannelConfig = (channelId: string, nextValue: unknown) => {
    if (!channelsCloned) {
      mutatedConfig = {
        ...mutatedConfig,
        channels: {
          ...mutatedConfig.channels,
        },
      };
      channelsCloned = true;
    }
    (mutatedConfig.channels as Record<string, unknown>)[channelId] = nextValue;
  };

  const replacePluginEntryConfig = (pluginId: string, nextValue: Record<string, unknown>) => {
    if (!pluginsCloned) {
      mutatedConfig = {
        ...mutatedConfig,
        plugins: {
          ...mutatedConfig.plugins,
        },
      };
      pluginsCloned = true;
    }
    if (!pluginEntriesCloned) {
      mutatedConfig.plugins = {
        ...mutatedConfig.plugins,
        entries: {
          ...mutatedConfig.plugins?.entries,
        },
      };
      pluginEntriesCloned = true;
    }
    const currentEntry = mutatedConfig.plugins?.entries?.[pluginId];
    mutatedConfig.plugins!.entries![pluginId] = {
      ...currentEntry,
      config: nextValue,
    };
  };

  const allowedChannels = new Set<string>(["defaults", "modelByChannel", ...CHANNEL_IDS]);

  if (config.channels && isRecord(config.channels)) {
    for (const key of Object.keys(config.channels)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      if (!allowedChannels.has(trimmed)) {
        const { registry } = ensureRegistry();
        for (const record of registry.plugins) {
          for (const channelId of record.channels) {
            allowedChannels.add(channelId);
          }
        }
      }
      if (!allowedChannels.has(trimmed)) {
        issues.push({
          path: `channels.${trimmed}`,
          message: `unknown channel id: ${trimmed}`,
        });
        continue;
      }

      const channelSchema = ensureChannelSchemas().get(trimmed)?.schema;
      if (!channelSchema) {
        continue;
      }
      const result = validateJsonSchemaValue({
        schema: channelSchema,
        cacheKey: `channel:${trimmed}`,
        value: config.channels[trimmed],
        applyDefaults: true, // Always apply defaults for AJV schema validation;
        // writeConfigFile persists persistCandidate, not validated.config (#61841)
      });
      if (!result.ok) {
        for (const error of result.errors) {
          issues.push({
            path:
              error.path === "<root>" ? `channels.${trimmed}` : `channels.${trimmed}.${error.path}`,
            message: `invalid config: ${error.message}`,
            allowedValues: error.allowedValues,
            allowedValuesHiddenCount: error.allowedValuesHiddenCount,
          });
        }
        continue;
      }
      replaceChannelConfig(trimmed, result.value);
    }
  }

  const heartbeatChannelIds = new Set<string>();
  for (const channelId of CHANNEL_IDS) {
    heartbeatChannelIds.add(normalizeLowercaseStringOrEmpty(channelId));
  }

  const validateHeartbeatTarget = (target: string | undefined, path: string) => {
    if (typeof target !== "string") {
      return;
    }
    const trimmed = target.trim();
    if (!trimmed) {
      issues.push({ path, message: "heartbeat target must not be empty" });
      return;
    }
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    if (normalized === "last" || normalized === "none") {
      return;
    }
    if (normalizeChatChannelId(trimmed)) {
      return;
    }
    if (!heartbeatChannelIds.has(normalized)) {
      const { registry } = ensureRegistry();
      for (const record of registry.plugins) {
        for (const channelId of record.channels) {
          const pluginChannel = channelId.trim();
          if (pluginChannel) {
            heartbeatChannelIds.add(normalizeLowercaseStringOrEmpty(pluginChannel));
          }
        }
      }
    }
    if (heartbeatChannelIds.has(normalized)) {
      return;
    }
    issues.push({ path, message: `unknown heartbeat target: ${target}` });
  };

  validateHeartbeatTarget(
    config.agents?.defaults?.heartbeat?.target,
    "agents.defaults.heartbeat.target",
  );
  if (Array.isArray(config.agents?.list)) {
    for (const [index, entry] of config.agents.list.entries()) {
      validateHeartbeatTarget(entry?.heartbeat?.target, `agents.list.${index}.heartbeat.target`);
    }
  }

  if (!hasExplicitPluginsConfig) {
    if (issues.length > 0) {
      return { ok: false, issues, warnings };
    }
    return { ok: true, config: mutatedConfig, warnings };
  }

  const { registry } = ensureRegistry();
  const knownIds = ensureKnownIds();
  const normalizedPlugins = ensureNormalizedPlugins();
  const effectiveConfig = ensureCompatConfig();
  const pushMissingPluginIssue = (
    path: string,
    pluginId: string,
    opts?: { warnOnly?: boolean },
  ) => {
    if (LEGACY_REMOVED_PLUGIN_IDS.has(pluginId)) {
      warnings.push({
        path,
        message: `plugin removed: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    if (opts?.warnOnly) {
      warnings.push({
        path,
        message: `plugin not found: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    issues.push({
      path,
      message: `plugin not found: ${pluginId}`,
    });
  };

  const pluginsConfig = config.plugins;

  const entries = pluginsConfig?.entries;
  if (entries && isRecord(entries)) {
    for (const pluginId of Object.keys(entries)) {
      if (!knownIds.has(pluginId)) {
        // Keep gateway startup resilient when plugins are removed/renamed across upgrades.
        pushMissingPluginIssue(`plugins.entries.${pluginId}`, pluginId, { warnOnly: true });
      }
    }
  }

  const allow = pluginsConfig?.allow ?? [];
  for (const pluginId of allow) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      const commandAlias = resolveManifestCommandAliasOwner({
        command: pluginId,
        registry,
      });
      if (commandAlias?.pluginId && knownIds.has(commandAlias.pluginId)) {
        warnings.push({
          path: "plugins.allow",
          message:
            `"${pluginId}" is not a plugin — it is a command provided by the "${commandAlias.pluginId}" plugin. ` +
            `Use "${commandAlias.pluginId}" in plugins.allow instead.`,
        });
      } else {
        pushMissingPluginIssue("plugins.allow", pluginId, { warnOnly: true });
      }
    }
  }

  const deny = pluginsConfig?.deny ?? [];
  for (const pluginId of deny) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.deny", pluginId);
    }
  }

  // The default memory slot is inferred; only a user-configured slot should block startup.
  const pluginSlots = pluginsConfig?.slots;
  const hasExplicitMemorySlot =
    pluginSlots !== undefined && Object.prototype.hasOwnProperty.call(pluginSlots, "memory");
  const memorySlot = normalizedPlugins.slots.memory;
  if (
    hasExplicitMemorySlot &&
    typeof memorySlot === "string" &&
    memorySlot.trim() &&
    !knownIds.has(memorySlot)
  ) {
    pushMissingPluginIssue("plugins.slots.memory", memorySlot);
  }

  let selectedMemoryPluginId: string | null = null;
  const seenPlugins = new Set<string>();
  for (const record of registry.plugins) {
    const pluginId = record.id;
    if (seenPlugins.has(pluginId)) {
      continue;
    }
    seenPlugins.add(pluginId);
    const entry = normalizedPlugins.entries[pluginId];
    const entryHasConfig = Boolean(entry?.config);

    const activationState = resolveEffectivePluginActivationState({
      id: pluginId,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: effectiveConfig,
    });
    let enabled = activationState.activated;
    let reason = activationState.reason;

    if (enabled) {
      const memoryDecision = resolveMemorySlotDecision({
        id: pluginId,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        enabled = false;
        reason = memoryDecision.reason;
      }
      if (memoryDecision.selected && hasKind(record.kind, "memory")) {
        selectedMemoryPluginId = pluginId;
      }
    }

    const shouldReplacePluginConfig = entryHasConfig || (opts.applyDefaults && enabled);
    const shouldValidate = enabled || entryHasConfig;
    if (shouldValidate) {
      if (record.configSchema) {
        const res = validateJsonSchemaValue({
          schema: record.configSchema,
          cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
          value: entry?.config ?? {},
          applyDefaults: true, // Always apply defaults for AJV schema validation;
          // writeConfigFile persists persistCandidate, not validated.config (#61841)
        });
        if (!res.ok) {
          for (const error of res.errors) {
            issues.push({
              path: resolvePluginConfigIssuePath(pluginId, error.path),
              message: `invalid config: ${error.message}`,
              allowedValues: error.allowedValues,
              allowedValuesHiddenCount: error.allowedValuesHiddenCount,
            });
          }
        } else if (shouldReplacePluginConfig) {
          replacePluginEntryConfig(pluginId, res.value as Record<string, unknown>);
        }
      } else if (record.format === "bundle") {
        // Compatible bundles currently expose no native OpenClaw config schema.
        // Treat them as schema-less capability packs rather than failing validation.
      } else {
        issues.push({
          path: `plugins.entries.${pluginId}`,
          message: `plugin schema missing for ${pluginId}`,
        });
      }
    }

    const suppressDisabledConfigWarning =
      ensureCompatPluginIds().has(pluginId) && !ensureOverriddenPluginIds().has(pluginId);
    if (!enabled && entryHasConfig && !suppressDisabledConfigWarning) {
      warnings.push({
        path: `plugins.entries.${pluginId}`,
        message: `plugin disabled (${reason ?? "disabled"}) but config is present`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, warnings };
  }

  return { ok: true, config: mutatedConfig, warnings };
}
