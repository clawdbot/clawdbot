import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { normalizeExactAllowedHost } from "../../../secrets/exact-hostname.js";

const HOST_KEYS = ["bypassHosts", "allowedHosts"] as const;

const rule = (
  path: string[],
  message: string,
  match?: LegacyConfigRule["match"],
): LegacyConfigRule => ({
  path,
  message: `${message} Run "openclaw doctor --fix".`,
  ...(match ? { match } : {}),
});

function isValidExactHostname(value: string): boolean {
  try {
    normalizeExactAllowedHost(value);
    return true;
  } catch {
    return false;
  }
}

export const LEGACY_CONFIG_MIGRATION_RUNTIME_SECRETS_EGRESS: LegacyConfigMigrationSpec =
  defineLegacyConfigMigration({
    id: "runtime.secrets-egress-proxy-hosts",
    describe: "Drop unusable secret egress proxy host entries",
    legacyRules: HOST_KEYS.map((key) =>
      rule(
        ["secrets", "egressProxy", key],
        `secrets.egressProxy.${key} contains entries that are not usable hostnames.`,
        (value) =>
          Array.isArray(value) &&
          value.some((entry) => typeof entry !== "string" || !isValidExactHostname(entry)),
      ),
    ),
    apply(raw, changes) {
      const egressProxy = getRecord(getRecord(raw.secrets)?.egressProxy);
      if (!egressProxy) {
        return;
      }

      for (const key of HOST_KEYS) {
        const hosts = egressProxy[key];
        if (!Array.isArray(hosts)) {
          continue;
        }
        const validHosts = hosts.filter(
          (entry): entry is string => typeof entry === "string" && isValidExactHostname(entry),
        );
        if (validHosts.length === hosts.length) {
          continue;
        }
        const invalidHosts = hosts.filter(
          (entry) => typeof entry !== "string" || !isValidExactHostname(entry),
        );

        // Invalid entries already prevented proxy startup, so dropping them loses no working policy.
        if (validHosts.length > 0) {
          egressProxy[key] = validHosts;
        } else {
          delete egressProxy[key];
        }
        changes.push(
          `Removed unusable secrets.egressProxy.${key} entries: ${invalidHosts
            .map((entry) => JSON.stringify(entry))
            .join(", ")}.`,
        );
      }
    },
  });
