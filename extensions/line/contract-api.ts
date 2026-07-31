// Line API module exposes the plugin public contract.
import type {
  PluginDoctorChannelIngressQueueAccess,
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import type { LineWebhookSpoolPayload } from "./src/webhook-spool-contract.js";
import { countLegacySpoolRows, migrateLineLegacySpoolRows } from "./src/webhook-spool-migration.js";

export {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "./src/accounts.js";

const LINE_CHANNEL_ID = "line";

/** Pre-drain rows can outlive the account config that admitted them, so the sweep
 *  enumerates accounts from the host's queue lane instead of the config; a host
 *  without the lane fails visibly rather than silently skipping the migration. */
function lineSpoolQueueAccess(
  context: PluginDoctorStateMigrationContext,
): PluginDoctorChannelIngressQueueAccess {
  const access = context.channelIngressQueues?.find((entry) => entry.channelId === LINE_CHANNEL_ID);
  if (!access) {
    throw new Error(
      "LINE pre-drain spool migration requires the doctor host's channel ingress queue access.",
    );
  }
  return access;
}

/** Doctor-owned upgrade migration for pre-drain (#109655) webhook spool rows. */
export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "line-pre-drain-spool-rows",
    label: "LINE pre-drain webhook spool rows",
    async detectLegacyState(params) {
      const spool = lineSpoolQueueAccess(params.context);
      const preview: string[] = [];
      for (const accountId of spool.listChannelIngressQueueAccountIds()) {
        const count = await countLegacySpoolRows(
          spool.openChannelIngressQueue<LineWebhookSpoolPayload>({ accountId }),
        );
        if (count > 0) {
          preview.push(
            `- LINE pre-drain spool rows (account "${accountId}"): ${count} row(s) -> canonical ingress contract`,
          );
        }
      }
      return preview.length > 0 ? { preview } : null;
    },
    async migrateLegacyState(params) {
      const spool = lineSpoolQueueAccess(params.context);
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const accountId of spool.listChannelIngressQueueAccountIds()) {
        const result = await migrateLineLegacySpoolRows(
          spool.openChannelIngressQueue<LineWebhookSpoolPayload>({ accountId }),
        );
        if (
          result.migrated > 0 ||
          result.reconciled > 0 ||
          result.deadLettered > 0 ||
          result.recovered > 0
        ) {
          const recovered =
            result.recovered > 0
              ? ` (${result.recovered} recovered from the dead-letter table)`
              : "";
          const reconciled =
            result.reconciled > 0
              ? `, ${result.reconciled} already settled under the canonical id`
              : "";
          changes.push(
            `Migrated LINE pre-drain spool rows (account "${accountId}"): ${result.migrated} delivered to the canonical queue, ${result.deadLettered} dead-lettered at the identity fence${reconciled}${recovered}`,
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
