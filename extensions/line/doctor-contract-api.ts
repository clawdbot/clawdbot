// Line doctor contract owns the pre-drain webhook spool upgrade migration.
import type {
  PluginDoctorChannelIngressQueueAccess,
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import type { LineWebhookSpoolPayload } from "./src/webhook-spool-contract.js";
import { countLegacySpoolRows, migrateLineLegacySpoolRows } from "./src/webhook-spool-migration.js";

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
      for (const accountId of await spool.listChannelIngressQueueAccountIds()) {
        const count = await countLegacySpoolRows(
          spool.openChannelIngressQueueForInspection<LineWebhookSpoolPayload>({ accountId }),
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
      const lineConfig = params.config.channels?.line;
      const configuredAccountIds = new Set<string>([
        ...Object.keys(lineConfig?.accounts ?? {}),
        ...(lineConfig ? ["default"] : []),
      ]);
      // The mutable lane exists only inside the host's exclusive repair section. A host
      // that reaches this phase without it must fail visibly rather than report success
      // over rows it never rewrote.
      const openForMigration = spool.openChannelIngressQueue;
      if (!openForMigration) {
        throw new Error(
          "LINE pre-drain spool migration requires mutable ingress access from the doctor host's exclusive repair section.",
        );
      }
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const accountId of await spool.listChannelIngressQueueAccountIds()) {
        const result = await migrateLineLegacySpoolRows(
          openForMigration<LineWebhookSpoolPayload>({ accountId }),
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
          // "queued", not "delivered": the migration admits rows to the canonical
          // queue, and the drain dispatches them. For an account the operator has
          // since removed there is no provider to drain it, so the row waits rather
          // than being delivered - say so instead of implying it already went out.
          const configured = configuredAccountIds.has(accountId);
          const dispatchNote = configured
            ? ""
            : ` (account not currently configured, so these stay queued until it is restored)`;
          changes.push(
            `Migrated LINE pre-drain spool rows (account "${accountId}"): ${result.migrated} queued under the canonical contract, ${result.deadLettered} dead-lettered at the identity fence${reconciled}${recovered}${dispatchNote}`,
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
