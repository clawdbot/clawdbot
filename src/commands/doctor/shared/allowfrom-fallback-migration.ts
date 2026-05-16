import { resolveChannelDmAllowFrom } from "../../../channels/plugins/dm-access.js";
import { normalizeAnyChannelId } from "../../../channels/registry.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../../config/bundled-channel-config-metadata.generated.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeStringEntries } from "../../../shared/string-normalization.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import { asObjectRecord } from "./object.js";

const PSEUDO_CHANNEL_KEYS = new Set(["defaults", "modelByChannel", "tools"]);
const ACCOUNT_SCHEMA_WILDCARD = "*";
const CHANNEL_GROUP_ALLOW_FROM_PATH = ["groupAllowFrom"] as const;
const ACCOUNT_GROUP_ALLOW_FROM_PATH = [
  "accounts",
  ACCOUNT_SCHEMA_WILDCARD,
  "groupAllowFrom",
] as const;

type ChannelRecord = Record<string, unknown>;
type SchemaPath = readonly string[];

function isDisabled(record: ChannelRecord): boolean {
  return record.enabled === false;
}

function normalizeAllowFrom(raw: unknown): string[] {
  return Array.from(new Set(normalizeStringEntries(Array.isArray(raw) ? raw : [])));
}

function readGroupAllowFrom(record: ChannelRecord): string[] {
  return normalizeAllowFrom(record.groupAllowFrom);
}

function readDmAllowFrom(params: {
  channelName: string;
  account: ChannelRecord;
  parent?: ChannelRecord;
}): string[] {
  return normalizeAllowFrom(
    resolveChannelDmAllowFrom({
      account: params.account,
      parent: params.parent,
      mode: getDoctorChannelCapabilities(params.channelName).dmAllowFromMode,
    }),
  );
}

function readOwnDmAllowFrom(params: { channelName: string; account: ChannelRecord }): string[] {
  return normalizeAllowFrom(
    resolveChannelDmAllowFrom({
      account: params.account,
      mode: getDoctorChannelCapabilities(params.channelName).dmAllowFromMode,
    }),
  );
}

function findGeneratedChannelConfigSchema(channelName: string): Record<string, unknown> | undefined {
  const normalizedChannelId = normalizeAnyChannelId(channelName);
  return GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (entry) => entry.channelId === channelName || entry.channelId === normalizedChannelId,
  )?.schema;
}

function schemaAllowsConfigPath(schema: unknown, path: SchemaPath): boolean {
  if (path.length === 0) {
    return true;
  }
  const node = asObjectRecord(schema);
  if (!node) {
    return true;
  }

  const anyOf = Array.isArray(node.anyOf) ? node.anyOf : undefined;
  if (anyOf) {
    return anyOf.some((branch) => schemaAllowsConfigPath(branch, path));
  }
  const oneOf = Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (oneOf) {
    return oneOf.some((branch) => schemaAllowsConfigPath(branch, path));
  }
  const allOf = Array.isArray(node.allOf) ? node.allOf : undefined;
  if (allOf) {
    return allOf.every((branch) => schemaAllowsConfigPath(branch, path));
  }

  const [segment, ...rest] = path;
  const properties = asObjectRecord(node.properties);
  if (
    segment !== ACCOUNT_SCHEMA_WILDCARD &&
    properties &&
    Object.prototype.hasOwnProperty.call(properties, segment)
  ) {
    return schemaAllowsConfigPath(properties[segment], rest);
  }

  const additionalProperties = node.additionalProperties;
  if (additionalProperties === false) {
    return false;
  }
  if (additionalProperties && typeof additionalProperties === "object") {
    return schemaAllowsConfigPath(additionalProperties, rest);
  }
  return true;
}

function generatedSchemaAllowsGroupAllowFrom(channelName: string, path: SchemaPath): boolean {
  const schema = findGeneratedChannelConfigSchema(channelName);
  return !schema || schemaAllowsConfigPath(schema, path);
}

function migrateRecord(params: {
  account: ChannelRecord;
  canWriteGroupAllowFrom: boolean;
  channelName: string;
  changes: string[];
  parent?: ChannelRecord;
  parentHadGroupAllowFrom?: boolean;
  prefix: string;
}): boolean {
  if (!params.canWriteGroupAllowFrom) {
    return false;
  }
  if (readGroupAllowFrom(params.account).length > 0) {
    return false;
  }
  if (params.parent && params.parentHadGroupAllowFrom) {
    return false;
  }
  const ownAllowFrom = readOwnDmAllowFrom(params);
  if (params.parent && ownAllowFrom.length === 0 && readGroupAllowFrom(params.parent).length > 0) {
    return false;
  }
  const allowFrom = readDmAllowFrom(params);
  if (allowFrom.length === 0) {
    return false;
  }
  params.account.groupAllowFrom = allowFrom;
  const noun = allowFrom.length === 1 ? "entry" : "entries";
  params.changes.push(
    `${params.prefix}.groupAllowFrom: copied ${allowFrom.length} sender ${noun} from allowFrom for explicit group allowlist.`,
  );
  return true;
}

export function maybeRepairGroupAllowFromFallback(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const channels = asObjectRecord(cfg.channels);
  if (!channels) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextChannels = next.channels as Record<string, ChannelRecord>;
  const changes: string[] = [];

  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (
      PSEUDO_CHANNEL_KEYS.has(channelName) ||
      !channelConfig ||
      typeof channelConfig !== "object"
    ) {
      continue;
    }
    if (isDisabled(channelConfig)) {
      continue;
    }
    if (!getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom) {
      continue;
    }

    const hadGroupAllowFrom = readGroupAllowFrom(channelConfig).length > 0;
    const canWriteChannelGroupAllowFrom = generatedSchemaAllowsGroupAllowFrom(
      channelName,
      CHANNEL_GROUP_ALLOW_FROM_PATH,
    );
    migrateRecord({
      account: channelConfig,
      canWriteGroupAllowFrom: canWriteChannelGroupAllowFrom,
      channelName,
      changes,
      prefix: `channels.${channelName}`,
    });

    const accounts = asObjectRecord(channelConfig.accounts);
    if (!accounts) {
      continue;
    }
    const canWriteAccountGroupAllowFrom = generatedSchemaAllowsGroupAllowFrom(
      channelName,
      ACCOUNT_GROUP_ALLOW_FROM_PATH,
    );
    for (const [accountId, accountConfig] of Object.entries(accounts)) {
      const account = asObjectRecord(accountConfig);
      if (!account || isDisabled(account)) {
        continue;
      }
      migrateRecord({
        account,
        canWriteGroupAllowFrom: canWriteAccountGroupAllowFrom,
        channelName,
        changes,
        parent: channelConfig,
        parentHadGroupAllowFrom: hadGroupAllowFrom,
        prefix: `channels.${channelName}.accounts.${accountId}`,
      });
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}
