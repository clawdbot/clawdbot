// Line API module exposes the plugin public contract.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  createChannelIngressQueue,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import { listLineAccountIds } from "./src/accounts.js";
import type { LineWebhookSpoolPayload } from "./src/webhook-spool-contract.js";
import { countLegacySpoolRows, migrateLineLegacySpoolRows } from "./src/webhook-spool-migration.js";

export {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "./src/accounts.js";

/** Pre-drain rows can outlive the account config that admitted them, so always
 *  include the default account alongside the currently configured ones. */
function lineSpoolAccountIds(config: OpenClawConfig): string[] {
  return Array.from(new Set([DEFAULT_ACCOUNT_ID, ...listLineAccountIds(config)]));
}

function openLineSpoolQueue(accountId: string, stateDir: string) {
  return createChannelIngressQueue<LineWebhookSpoolPayload>({
    channelId: "line",
    accountId,
    stateDir,
  });
}

/** Doctor-owned upgrade migration for pre-drain (#109655) webhook spool rows. */
export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "line-pre-drain-spool-rows",
    label: "LINE pre-drain webhook spool rows",
    async detectLegacyState(params) {
      const preview: string[] = [];
      for (const accountId of lineSpoolAccountIds(params.config)) {
        const count = await countLegacySpoolRows(openLineSpoolQueue(accountId, params.stateDir));
        if (count > 0) {
          preview.push(
            `- LINE pre-drain spool rows (account "${accountId}"): ${count} row(s) -> canonical ingress contract`,
          );
        }
      }
      return preview.length > 0 ? { preview } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const accountId of lineSpoolAccountIds(params.config)) {
        const result = await migrateLineLegacySpoolRows(
          openLineSpoolQueue(accountId, params.stateDir),
        );
        if (result.migrated > 0 || result.deadLettered > 0 || result.recovered > 0) {
          const recovered =
            result.recovered > 0
              ? ` (${result.recovered} recovered from the dead-letter table)`
              : "";
          changes.push(
            `Migrated LINE pre-drain spool rows (account "${accountId}"): ${result.migrated} delivered to the canonical queue, ${result.deadLettered} dead-lettered at the identity fence${recovered}`,
          );
        }
        for (const failure of result.failures) {
          warnings.push(
            `Failed migrating a LINE pre-drain spool row (account "${accountId}", ${failure}); the row stays pending and the migration retries on the next run`,
          );
        }
      }
      return { changes, warnings };
    },
  },
];
