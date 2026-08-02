/**
 * Keeps plugin-owned channel schemas from rejecting core-owned channel keys.
 */
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Channel-common keys core itself writes into plugin-owned channel entries.
 *
 * Deliberately not every common key. `buildCommonChannelAccountShape` takes an
 * `omit` list, so a channel schema that lacks a common field is usually saying
 * the channel does not support it; widening all of them would silently accept
 * config that can never take effect. These keys are different: core's doctor
 * migration writes them into `channels.<id>` and its accounts for every channel,
 * so a plugin schema that rejects one turns config core produced into a startup
 * failure. Core wrote it, so core has to accept it.
 *
 * Keep in sync with migrateHeartbeatVisibility in
 * src/commands/doctor/shared/channel-legacy-config-migrate.ts.
 */
const CORE_WRITTEN_CHANNEL_ENTRY_KEYS: readonly string[] = ["heartbeatVisibility"];

/**
 * Channel plugins publish closed schemas (`additionalProperties: false`) that
 * enumerate only the keys they knew about when that plugin version shipped. Core
 * keeps adding channel-common keys and then reads, documents, and migrates into
 * them for every channel, so a plugin published before such a key turns config
 * core itself wrote into a hard startup failure (`78/CONFIG`) that
 * `openclaw doctor --fix` cannot repair.
 *
 * Core already validated these keys in its own schema pass before the plugin pass
 * runs, so permitting them here loses no checking — it only stops plugin vintage
 * from deciding whether core-written config is loadable. Ownership, not leniency:
 * the plugin still fully owns every key it declares, every common key core does
 * not write stays rejectable, and unknown keys are still rejected.
 */
function permitCoreOwnedChannelKeys(schema: Record<string, unknown>): Record<string, unknown> {
  // Only closed schemas can reject; an open schema already accepts these keys.
  if (schema.additionalProperties !== false) {
    return schema;
  }
  // A closed schema may legally omit `properties` altogether, which rejects
  // every key — the worst case for core-owned config, not a case to skip.
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const missing = CORE_WRITTEN_CHANNEL_ENTRY_KEYS.filter((key) => !Object.hasOwn(properties, key));
  if (missing.length === 0) {
    return schema;
  }
  return {
    ...schema,
    properties: {
      ...properties,
      // Empty schema = "accept, already validated upstream by core".
      ...Object.fromEntries(missing.map((key) => [key, {}])),
    },
  };
}

/**
 * Applies {@link permitCoreOwnedChannelKeys} to a channel schema and to its
 * per-account entries, because core resolves these keys at channel and account
 * level alike (`channels.<id>.accounts.<id>.heartbeatVisibility`).
 *
 * Returns the input unchanged when nothing needs widening, so callers can keep
 * caching schemas by identity.
 */
export function resolveChannelSchemaWithCoreOwnedKeys(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const base = permitCoreOwnedChannelKeys(schema);
  const properties = isPlainRecord(base.properties) ? base.properties : undefined;
  const accounts =
    properties && isPlainRecord(properties.accounts) ? properties.accounts : undefined;
  const accountEntry =
    accounts && isPlainRecord(accounts.additionalProperties)
      ? accounts.additionalProperties
      : undefined;
  if (!accountEntry) {
    return base;
  }
  const widenedAccountEntry = permitCoreOwnedChannelKeys(accountEntry);
  if (widenedAccountEntry === accountEntry) {
    return base;
  }
  return {
    ...base,
    properties: {
      ...properties,
      accounts: { ...accounts, additionalProperties: widenedAccountEntry },
    },
  };
}
