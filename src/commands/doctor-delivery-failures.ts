// Doctor visibility for retained outbound/session failure ownership.
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { getDeliveryFailureMaintenanceHealth } from "../infra/delivery-queue-failure-maintenance.js";
import { summarizeDeliveryFailureQueues } from "../infra/delivery-queue-failure-summary.js";
import { DELIVERY_FAILURE_DETAIL_RETENTION_MS } from "../infra/delivery-queue-terminal-policy.js";

export function noteDeliveryFailures(options?: { stateDir?: string; noteFn?: typeof note }): void {
  const queues = summarizeDeliveryFailureQueues(options?.stateDir);
  const maintenance = getDeliveryFailureMaintenanceHealth();
  if (queues.length === 0 && maintenance.errors === 0) {
    return;
  }
  const now = Date.now();
  const lines = queues.map((queue) => {
    const oldestPayloadOverdue =
      queue.oldestPayloadFailedAt !== null &&
      queue.oldestPayloadFailedAt <= now - DELIVERY_FAILURE_DETAIL_RETENTION_MS;
    return `- ${queue.queueName}: ${queue.count} failed; full=${queue.full}, compacted=${queue.compacted}, payload-bearing=${queue.payloadBearing}, owner-cleanup-pending=${queue.ownerCleanupPending}, oldest-payload-overdue=${oldestPayloadOverdue ? "yes" : "no"}, legacy-unknown=${queue.legacyUnknown}.`;
  });
  if (maintenance.errors > 0) {
    lines.push(`- Last retention maintenance reported ${maintenance.errors} error(s).`);
  }
  lines.push(`- Inspect with ${formatCliCommand("openclaw delivery failures list")}.`);
  if (queues.some((queue) => queue.ownerManaged > 0)) {
    lines.push(
      `- Subagent-owned failures use ${formatCliCommand("openclaw tasks retry <task-id>")} or ${formatCliCommand("openclaw tasks dismiss <task-id>")}.`,
    );
  }
  (options?.noteFn ?? note)(lines.join("\n"), "Delivery failures");
}
