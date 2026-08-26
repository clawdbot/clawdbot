import type { Static } from "typebox";
import {
  asProtocolRecord,
  normalizeOptionalProtocolString,
} from "./protocol-value-normalization.js";
import type {
  CapabilityConsentErrorDetailsSchema,
  PluginDeclaredSurfaceSchema,
  PluginDeclaredSurfaceWideningSchema,
  PluginInspectSourceSchema,
  PluginInstallTrustSchema,
  PluginOperatorGrantsSchema,
} from "./schema/plugins.js";

export const PLUGIN_CAPABILITY_CONSENT_REQUIRED = "PLUGIN_CAPABILITY_CONSENT_REQUIRED" as const;

export type CapabilityConsentErrorDetails = Static<typeof CapabilityConsentErrorDetailsSchema>;

type PluginDeclaredSurface = Static<typeof PluginDeclaredSurfaceSchema>;
type PluginDeclaredSurfaceWidening = Static<typeof PluginDeclaredSurfaceWideningSchema>;
type PluginOperatorGrants = Static<typeof PluginOperatorGrantsSchema>;
type PluginInspectSource = Static<typeof PluginInspectSourceSchema>;
type PluginInstallTrust = Static<typeof PluginInstallTrustSchema>;

const DECLARED_SURFACE_GROUPS = [
  "channels",
  "providers",
  "tools",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
] as const satisfies readonly (keyof PluginDeclaredSurface)[];

const SOURCE_KINDS = [
  "bundled",
  "clawhub",
  "npm",
  "git",
  "path",
  "archive",
  "marketplace",
  "official-catalog",
] as const;

const INTEGRITY_KINDS = ["ssri", "sha256", "git-commit"] as const;

const TRUST_DISPOSITIONS = ["clean", "review-recommended", "review-required", "blocked"] as const;

const MODEL_OVERRIDE_FLAGS = [
  "allowModelOverride",
  "allowAuthProfileOverride",
  "allowAgentIdOverride",
] as const;

const MODEL_OVERRIDE_LISTS = ["allowedModels", "allowedCompletionModels"] as const;

/** The wire schemas are closed objects, so unknown keys must fail the read. */
function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: string[] = [];
  for (const entry of value) {
    const item = normalizeOptionalProtocolString(entry);
    if (!item) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

function readOptionalBoolean(value: unknown): { ok: boolean; value?: boolean } {
  if (value === undefined) {
    return { ok: true };
  }
  return typeof value === "boolean" ? { ok: true, value } : { ok: false };
}

function readDeclaredSurface(value: unknown): PluginDeclaredSurface | undefined {
  const record = asProtocolRecord(value);
  if (!record || !hasOnlyKeys(record, DECLARED_SURFACE_GROUPS)) {
    return undefined;
  }
  const channels = readStringList(record.channels);
  const providers = readStringList(record.providers);
  const tools = readStringList(record.tools);
  const hooks = readStringList(record.hooks);
  const mcpServers = readStringList(record.mcpServers);
  const cliCommands = readStringList(record.cliCommands);
  const cliBackends = readStringList(record.cliBackends);
  const skills = readStringList(record.skills);
  const dangerousConfigFlags = readStringList(record.dangerousConfigFlags);
  if (
    !channels ||
    !providers ||
    !tools ||
    !hooks ||
    !mcpServers ||
    !cliCommands ||
    !cliBackends ||
    !skills ||
    !dangerousConfigFlags
  ) {
    return undefined;
  }
  return {
    channels,
    providers,
    tools,
    hooks,
    mcpServers,
    cliCommands,
    cliBackends,
    skills,
    dangerousConfigFlags,
  };
}

function readDeclaredSurfaceWidening(value: unknown): PluginDeclaredSurfaceWidening | undefined {
  const record = asProtocolRecord(value);
  if (!record) {
    return undefined;
  }
  if (!hasOnlyKeys(record, DECLARED_SURFACE_GROUPS)) {
    return undefined;
  }
  const widened: PluginDeclaredSurfaceWidening = {};
  for (const group of DECLARED_SURFACE_GROUPS) {
    if (record[group] === undefined) {
      continue;
    }
    const items = readStringList(record[group]);
    if (!items) {
      return undefined;
    }
    widened[group] = items;
  }
  return widened;
}

function readHookGrant(
  value: unknown,
): PluginOperatorGrants["hooks"]["allowPromptInjection"] | undefined {
  const record = asProtocolRecord(value);
  if (
    !record ||
    typeof record.effective !== "boolean" ||
    !hasOnlyKeys(record, ["effective", "configured"])
  ) {
    return undefined;
  }
  const configured = readOptionalBoolean(record.configured);
  if (!configured.ok) {
    return undefined;
  }
  return {
    effective: record.effective,
    ...(configured.value !== undefined ? { configured: configured.value } : {}),
  };
}

function readModelOverrides(
  value: unknown,
): { ok: true; value?: PluginOperatorGrants["llm"] } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  const record = asProtocolRecord(value);
  if (!record) {
    return { ok: false };
  }
  if (!hasOnlyKeys(record, [...MODEL_OVERRIDE_FLAGS, ...MODEL_OVERRIDE_LISTS])) {
    return { ok: false };
  }
  const overrides: NonNullable<PluginOperatorGrants["llm"]> = {};
  for (const flag of MODEL_OVERRIDE_FLAGS) {
    const flagValue = readOptionalBoolean(record[flag]);
    if (!flagValue.ok) {
      return { ok: false };
    }
    if (flagValue.value !== undefined) {
      overrides[flag] = flagValue.value;
    }
  }
  for (const list of MODEL_OVERRIDE_LISTS) {
    if (record[list] === undefined) {
      continue;
    }
    const items = readStringList(record[list]);
    if (!items) {
      return { ok: false };
    }
    overrides[list] = items;
  }
  return { ok: true, value: overrides };
}

function readGrants(value: unknown): PluginOperatorGrants | undefined {
  const record = asProtocolRecord(value);
  const hooks = record ? asProtocolRecord(record.hooks) : undefined;
  if (
    !record ||
    !hooks ||
    !hasOnlyKeys(record, ["hooks", "llm", "subagent"]) ||
    !hasOnlyKeys(hooks, ["allowPromptInjection", "allowConversationAccess"])
  ) {
    return undefined;
  }
  const allowPromptInjection = readHookGrant(hooks.allowPromptInjection);
  const allowConversationAccess = readHookGrant(hooks.allowConversationAccess);
  const llm = readModelOverrides(record.llm);
  const subagent = readModelOverrides(record.subagent);
  if (!allowPromptInjection || !allowConversationAccess || !llm.ok || !subagent.ok) {
    return undefined;
  }
  return {
    hooks: { allowPromptInjection, allowConversationAccess },
    ...(llm.value ? { llm: llm.value } : {}),
    ...(subagent.value ? { subagent: { ...subagent.value } } : {}),
  };
}

function readSource(value: unknown): { ok: true; value?: PluginInspectSource } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  const record = asProtocolRecord(value);
  if (!record) {
    return { ok: false };
  }
  const kind = SOURCE_KINDS.find((candidate) => candidate === record.kind);
  if (
    !kind ||
    !hasOnlyKeys(record, ["kind", "spec", "packageName", "integrity", "integrityKind"])
  ) {
    return { ok: false };
  }
  const spec = normalizeOptionalProtocolString(record.spec);
  const packageName = normalizeOptionalProtocolString(record.packageName);
  const integrity = normalizeOptionalProtocolString(record.integrity);
  const integrityKind = INTEGRITY_KINDS.find((candidate) => candidate === record.integrityKind);
  if (
    (record.spec !== undefined && !spec) ||
    (record.packageName !== undefined && !packageName) ||
    (record.integrity !== undefined && !integrity) ||
    (record.integrityKind !== undefined && !integrityKind)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      kind,
      ...(spec ? { spec } : {}),
      ...(packageName ? { packageName } : {}),
      ...(integrity ? { integrity } : {}),
      ...(integrityKind ? { integrityKind } : {}),
    },
  };
}

function readTrust(value: unknown): { ok: true; value?: PluginInstallTrust } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  const record = asProtocolRecord(value);
  if (!record) {
    return { ok: false };
  }
  const disposition = TRUST_DISPOSITIONS.find((candidate) => candidate === record.disposition);
  if (
    !disposition ||
    !hasOnlyKeys(record, [
      "disposition",
      "reasons",
      "checkedAt",
      "acknowledgedAt",
      "pending",
      "stale",
    ])
  ) {
    return { ok: false };
  }
  const checkedAt = normalizeOptionalProtocolString(record.checkedAt);
  const acknowledgedAt = normalizeOptionalProtocolString(record.acknowledgedAt);
  const pending = readOptionalBoolean(record.pending);
  const stale = readOptionalBoolean(record.stale);
  let reasons: string[] | undefined;
  if (record.reasons !== undefined) {
    if (!Array.isArray(record.reasons) || record.reasons.some((r) => typeof r !== "string")) {
      return { ok: false };
    }
    reasons = record.reasons as string[];
  }
  if (
    (record.checkedAt !== undefined && !checkedAt) ||
    (record.acknowledgedAt !== undefined && !acknowledgedAt) ||
    !pending.ok ||
    !stale.ok
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      disposition,
      ...(reasons ? { reasons } : {}),
      ...(checkedAt ? { checkedAt } : {}),
      ...(acknowledgedAt ? { acknowledgedAt } : {}),
      ...(pending.value !== undefined ? { pending: pending.value } : {}),
      ...(stale.value !== undefined ? { stale: stale.value } : {}),
    },
  };
}

export function buildCapabilityConsentErrorDetails(
  details: Omit<CapabilityConsentErrorDetails, "capabilityConsentCode">,
): CapabilityConsentErrorDetails {
  return {
    capabilityConsentCode: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
    ...details,
  };
}

/**
 * Structural reader instead of the compiled validator registry: the Control UI
 * imports this on its startup path, and pulling the registry in would drag every
 * protocol schema into the browser startup bundle.
 */
export function readCapabilityConsentErrorDetails(
  value: unknown,
): CapabilityConsentErrorDetails | undefined {
  const record = asProtocolRecord(value);
  if (
    !record ||
    record.capabilityConsentCode !== PLUGIN_CAPABILITY_CONSENT_REQUIRED ||
    !hasOnlyKeys(record, [
      "capabilityConsentCode",
      "pluginId",
      "name",
      "version",
      "declared",
      "grants",
      "source",
      "trust",
      "widened",
      "acceptedAt",
    ])
  ) {
    return undefined;
  }
  const pluginId = normalizeOptionalProtocolString(record.pluginId);
  const name = normalizeOptionalProtocolString(record.name);
  const version = normalizeOptionalProtocolString(record.version);
  const acceptedAt = normalizeOptionalProtocolString(record.acceptedAt);
  const declared = readDeclaredSurface(record.declared);
  const grants = readGrants(record.grants);
  const source = readSource(record.source);
  const trust = readTrust(record.trust);
  const widened =
    record.widened === undefined ? undefined : readDeclaredSurfaceWidening(record.widened);
  if (
    !pluginId ||
    !name ||
    !declared ||
    !grants ||
    !source.ok ||
    !trust.ok ||
    (record.version !== undefined && !version) ||
    (record.acceptedAt !== undefined && !acceptedAt) ||
    (record.widened !== undefined && !widened)
  ) {
    return undefined;
  }
  return {
    capabilityConsentCode: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
    pluginId,
    name,
    ...(version ? { version } : {}),
    declared,
    grants,
    ...(source.value ? { source: source.value } : {}),
    ...(trust.value ? { trust: trust.value } : {}),
    ...(widened ? { widened } : {}),
    ...(acceptedAt ? { acceptedAt } : {}),
  };
}
