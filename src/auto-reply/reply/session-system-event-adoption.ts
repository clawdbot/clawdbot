import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSessionRecipientAuthorityCurrent } from "../../config/sessions/session-accessor.js";
import { toErrorObject } from "../../infra/errors.js";
import { ackSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import { consumeSelectedSystemEventEntries, type SystemEvent } from "../../infra/system-events.js";

export type PreparedSystemEventAuthority = {
  status: () => "current" | "stale" | "settled";
  settleStale: () => Promise<void>;
};

export type PreparedSystemEventBlock = {
  key?: string;
  text: string;
  authority?: PreparedSystemEventAuthority;
};

export type PreparedManagedSystemEventDelivery = {
  id: string;
  acknowledge: () => Promise<void>;
  authority?: PreparedSystemEventAuthority;
};

export type PreparedFormattedSystemEvents = {
  blocks: PreparedSystemEventBlock[];
  managedDeliveries: PreparedManagedSystemEventDelivery[];
};

const MESSAGE_METADATA_KEY = "__openclaw";

function readSessionDeliveryAckIds(message: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(message)) {
    return ids;
  }
  const metadata = message[MESSAGE_METADATA_KEY];
  if (!isRecord(metadata) || !Array.isArray(metadata.sessionDeliveryAckIds)) {
    return ids;
  }
  for (const id of metadata.sessionDeliveryAckIds) {
    const normalized = normalizeOptionalString(id);
    if (normalized) {
      ids.add(normalized);
    }
  }
  return ids;
}

export function readAdoptedSystemEventDeliveryIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (isRecord(event)) {
      for (const id of readSessionDeliveryAckIds(event.message)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

export async function acknowledgePersistedManagedSystemEvents(params: {
  deliveries: Iterable<PreparedManagedSystemEventDelivery>;
  persistedMessage: unknown;
}): Promise<void> {
  const adoptedIds = readSessionDeliveryAckIds(params.persistedMessage);
  let firstError: Error | undefined;
  for (const delivery of params.deliveries) {
    if (!adoptedIds.has(delivery.id)) {
      continue;
    }
    try {
      await delivery.acknowledge();
    } catch (error) {
      firstError ??= toErrorObject(error, "Managed session delivery acknowledgement failed");
    }
  }
  if (firstError) {
    throw firstError;
  }
}

export async function settleManagedSystemEventsAfterTurnAdoption(params: {
  deliveries: Iterable<PreparedManagedSystemEventDelivery>;
  persistedMessage: unknown;
  onTurnAdopted?: () => void | Promise<void>;
}): Promise<void> {
  // Tombstone the ingress claim first. Delivery settlement can replay from the
  // transcript receipt; an untombstoned claim can replay the injected turn.
  await params.onTurnAdopted?.();
  await acknowledgePersistedManagedSystemEvents(params);
}

export async function settleStaleSystemEventAuthority(params: {
  event: SystemEvent;
  sessionKey: string;
}): Promise<void> {
  if (params.event.sessionDeliveryAckId) {
    await ackSessionDelivery(
      params.event.sessionDeliveryAckId,
      params.event.sessionDeliveryAckStateDir,
    );
  }
  consumeSelectedSystemEventEntries(params.sessionKey, [params.event]);
}

export function createPreparedSystemEventAuthorityResolver(scope: {
  agentId: string;
  sessionKey: string;
  storePath: string;
}): (event: SystemEvent) => PreparedSystemEventAuthority | undefined {
  const byId = new Map<string, PreparedSystemEventAuthority>();
  const byEvent = new WeakMap<SystemEvent, PreparedSystemEventAuthority>();
  return (event) => {
    const authority = event.recipientAuthority;
    if (!authority) {
      return undefined;
    }
    const existing = event.id ? byId.get(event.id) : byEvent.get(event);
    if (existing) {
      return existing;
    }
    let settled = false;
    let settlement: Promise<void> | undefined;
    const created: PreparedSystemEventAuthority = {
      status: () =>
        settled
          ? "settled"
          : isSessionRecipientAuthorityCurrent(scope, authority)
            ? "current"
            : "stale",
      settleStale: () => {
        // Bind the exact store scope and queue occurrence; a later session
        // incarnation cannot redirect settlement.
        settlement ??= settleStaleSystemEventAuthority({
          event,
          sessionKey: scope.sessionKey,
        }).then(() => {
          settled = true;
        });
        return settlement;
      },
    };
    if (event.id) {
      byId.set(event.id, created);
    } else {
      byEvent.set(event, created);
    }
    return created;
  };
}

export function resolveFinalSystemEventAdoption(params: {
  prepared: readonly PreparedFormattedSystemEvents[];
  replaceDeliveryIds?: (deliveryIds: readonly string[]) => boolean;
}) {
  const blocks = params.prepared.flatMap((entry) => entry.blocks);
  const deliveries = params.prepared.flatMap((entry) => entry.managedDeliveries);
  const authorities = new Set(
    [...blocks, ...deliveries].flatMap((entry) => (entry.authority ? [entry.authority] : [])),
  );
  const statusByAuthority = new Map(
    [...authorities].map((authority) => [authority, authority.status()] as const),
  );
  const staleAuthorities = [...statusByAuthority].flatMap(([authority, status]) =>
    status === "stale" ? [authority] : [],
  );
  if (staleAuthorities.length > 0) {
    return {
      kind: "settle-stale" as const,
      settle: async () => {
        for (const authority of staleAuthorities) {
          await authority.settleStale();
        }
      },
    };
  }

  const isAdoptable = (authority: PreparedSystemEventAuthority | undefined) =>
    !authority || statusByAuthority.get(authority) === "current";
  const adoptedDeliveries = new Map(
    deliveries
      .filter((delivery) => isAdoptable(delivery.authority))
      .map((delivery) => [delivery.id, delivery]),
  );
  const deliveryIds = [...adoptedDeliveries.keys()];
  const recorderAccepted = params.replaceDeliveryIds?.(deliveryIds) ?? true;
  const deferredBlockKeys = recorderAccepted
    ? undefined
    : new Set(deliveryIds.map((id) => `session-delivery:${id}`));

  return {
    kind: "adopted" as const,
    blocks: blocks.filter(
      (block) => isAdoptable(block.authority) && !deferredBlockKeys?.has(block.key ?? ""),
    ),
    managedDeliveries: recorderAccepted
      ? adoptedDeliveries
      : new Map<string, PreparedManagedSystemEventDelivery>(),
  };
}
