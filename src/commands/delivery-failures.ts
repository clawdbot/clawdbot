// Operator-facing metadata inspection and safe recovery for terminal deliveries.
import type {
  DeliveryFailureResubmitReason,
  DeliveryFailureResubmitResult,
} from "../../packages/gateway-protocol/src/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "../cli/gateway-rpc.js";
import {
  listDeliveryFailures,
  purgeDeliveryFailures,
  type DeliveryFailureMetadata,
} from "../infra/delivery-queue-failures.js";
import { formatDurationHuman } from "../infra/format-time/format-duration.js";
import { releasePurgedOutboundDeliveryMedia } from "../infra/outbound/delivery-queue-failures.js";
import { OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS } from "../infra/outbound/delivery-queue-storage.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

type DeliveryFailuresListOptions = {
  queue?: string;
  limit?: number;
  before?: number;
  exactIds?: boolean;
  json?: boolean;
};

function outputFence(fence: DeliveryFailureMetadata["fence"], exactIds: boolean | undefined) {
  if (fence.kind !== "producer-bounded") {
    return fence;
  }
  const { idPrefix, ...retention } = fence;
  return exactIds
    ? { ...retention, idPrefix }
    : { ...retention, idPrefixFingerprint: redactIdentifier(idPrefix) };
}

function formatOutputFence(fence: ReturnType<typeof outputFence>): string {
  if (fence.kind !== "producer-bounded") {
    return fence.kind;
  }
  const prefix =
    "idPrefix" in fence
      ? `idPrefix=${fence.idPrefix}`
      : `idPrefixFingerprint=${fence.idPrefixFingerprint}`;
  return `${fence.kind} maxAgeMs=${fence.maxAgeMs} maxEntries=${fence.maxEntries} ${prefix}`;
}

function outputFailureMetadata(
  rows: DeliveryFailureMetadata[],
  options: Pick<DeliveryFailuresListOptions, "exactIds" | "json">,
  runtime: RuntimeEnv,
): void {
  const output = rows.map((row) => ({
    ...(options.exactIds ? { id: row.id } : { fingerprint: redactIdentifier(row.id) }),
    queue: row.queueName,
    failedAt: row.failedAt,
    ageMs: row.failedAt == null ? null : Math.max(0, Date.now() - row.failedAt),
    detail: row.detail,
    replay: row.replay,
    fence: outputFence(row.fence, options.exactIds),
    reason: row.reason,
    retries: row.retryCount,
    payloadBearing: row.payloadBearing,
    legacyUnknown: row.legacyUnknown,
    ...(row.owner ? { owner: row.owner } : {}),
  }));
  if (options.json) {
    writeRuntimeJson(runtime, { failures: output, count: output.length });
    return;
  }
  if (output.length === 0) {
    runtime.log("No retained delivery failures.");
    return;
  }
  for (const row of output) {
    const identifier = "id" in row ? row.id : row.fingerprint;
    runtime.log(
      `${identifier}  ${row.queue}  ${formatDurationHuman(row.ageMs)}  detail=${row.detail} replay=${row.replay} fence=${formatOutputFence(row.fence)} reason=${row.reason} retries=${row.retries}`,
    );
  }
}

export function deliveryFailuresListCommand(
  options: DeliveryFailuresListOptions,
  runtime: RuntimeEnv,
): void {
  const rows = listDeliveryFailures({
    queueName: options.queue,
    limit: options.limit,
    before: options.before,
  });
  outputFailureMetadata(rows, options, runtime);
}

export async function deliveryFailuresPurgeCommand(
  options: DeliveryFailuresListOptions & { apply?: boolean; yes?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  if (options.yes && !options.apply) {
    throw new Error("--yes requires --apply; purge is a dry run by default");
  }
  let apply = options.apply === true;
  if (apply && !options.yes) {
    if (options.json || !process.stdin.isTTY) {
      throw new Error("Purge apply requires confirmation. Pass --apply --yes non-interactively.");
    }
    apply = await createClackPrompter().confirm({
      message: "Compact eligible delivery failure detail and delete expired diagnostic rows?",
      initialValue: false,
    });
    if (!apply) {
      runtime.log("Cancelled.");
      return;
    }
  }
  const result = await purgeDeliveryFailures({
    queueName: options.queue,
    limit: options.limit,
    apply,
    afterApply: (action) =>
      OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.some(
        (descriptor) => descriptor.queueName === action.queueName,
      )
        ? releasePurgedOutboundDeliveryMedia(action)
        : Promise.resolve(),
  });
  if (options.json) {
    writeRuntimeJson(runtime, { applied: apply, ...result });
  } else {
    runtime.log(
      `${apply ? "Applied" : "Dry run"}: scanned=${result.scanned}, compacted=${result.compacted}, deleted=${result.deleted}, legacyUnknown=${result.legacyUnknown}, errors=${result.errors}.`,
    );
    if (!apply) {
      runtime.log(
        `Re-run with ${formatCliCommand("openclaw delivery failures purge --apply --yes")} to apply.`,
      );
    }
  }
  if (result.errors > 0) {
    runtime.error(
      "Purge completed with storage or media cleanup errors; start the Gateway to run queue media recovery and inspect delivery failures again.",
    );
    runtime.exit(1);
  }
}

export async function deliveryFailuresResubmitCommand(
  id: string,
  options: GatewayRpcOpts & { queue?: string; exactIds?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const { queue, exactIds, ...gatewayOptions } = options;
  const result = (await callGatewayFromCli(
    "delivery.failures.resubmit",
    gatewayOptions,
    { id, ...(queue ? { queueName: queue } : {}) },
    { scopes: ["operator.admin"] },
  )) as DeliveryFailureResubmitResult;
  const identifier = exactIds ? id : redactIdentifier(id);
  if (options.json) {
    writeRuntimeJson(runtime, {
      ...(exactIds ? { id } : { fingerprint: identifier }),
      ...result,
    });
  } else if (result.ok) {
    const message =
      result.disposition === "scheduled"
        ? `Queued session delivery ${identifier} for immediate Gateway recovery (scheduled).`
        : result.disposition === "queued_for_startup"
          ? `Session delivery ${identifier} is durably queued for Gateway startup recovery; immediate scheduling failed or was unavailable.`
          : `Queued outbound delivery ${identifier} for Gateway recovery.`;
    runtime.log(message);
  } else {
    runtime.error(`Delivery was not queued: ${DELIVERY_RESUBMIT_REASON_MESSAGES[result.reason]}`);
  }
  if (!result.ok) {
    runtime.exit(1);
  }
}

const DELIVERY_RESUBMIT_REASON_MESSAGES: Record<DeliveryFailureResubmitReason, string> = {
  not_found: "no retained failure matched; run openclaw delivery failures list --exact-ids",
  not_failed: "the entry is no longer failed; inspect it with openclaw delivery failures list",
  legacy_unknown: "legacy or unreadable ownership is retained and cannot be resubmitted",
  compacted: "sensitive delivery detail was already compacted",
  owner_managed: "the owner controls recovery; use openclaw tasks retry or tasks dismiss",
  ambiguous: "delivery side effects may already have started",
  fenced: "stable delivery ownership is fenced",
  missing_payload: "the full canonical prepared payload is unavailable",
  missing_media: "required queue-owned media is missing; inspect or purge the failure",
  ownership_changed: "delivery ownership changed; list the failure and retry if still eligible",
  migration_namespace: "automatic migration owns recovery for this queue namespace",
  unsupported_queue: "the selected queue namespace does not support generic resubmit",
  ambiguous_queue:
    "the ID has competing queue owners; inspect openclaw delivery failures list --exact-ids. For a session/outbound collision use --queue session or --queue outbound-prepared-v1; retired namespace duplicates require migration repair",
};
