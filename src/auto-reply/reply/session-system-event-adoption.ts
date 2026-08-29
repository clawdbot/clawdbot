import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSessionRecipientAuthorityCurrent } from "../../config/sessions/session-accessor.js";
import type { SessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-types.js";
import { toErrorObject } from "../../infra/errors.js";
import { ackSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import { consumeSelectedSystemEventEntries, type SystemEvent } from "../../infra/system-events.js";

type PreparedAuthorityScope = { agentId: string; sessionKey: string; storePath: string };
type PreparedAuthorityBinding = {
  authority: SessionRecipientAuthority;
  event: SystemEvent;
};
export type PreparedSystemEventAuthorityOwner = {
  scope: PreparedAuthorityScope;
  pending: Map<string, PreparedAuthorityBinding>;
};

export type PreparedSystemEventBlock = {
  key?: string;
  text: string;
  authorityKey?: string;
};

export type PreparedManagedSystemEventDelivery = {
  id: string;
  acknowledge: () => Promise<void>;
  authorityKey?: string;
};

export type PreparedFormattedSystemEvents = {
  blocks: PreparedSystemEventBlock[];
  managedDeliveries: PreparedManagedSystemEventDelivery[];
  authorityOwner?: PreparedSystemEventAuthorityOwner;
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

async function acknowledgePersistedManagedSystemEvents(params: {
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

export function readPreparedSystemEventAuthorityKey(event: SystemEvent): string | undefined {
  const key = event.recipientAuthority ? (event.id ?? event.sessionDeliveryAckId) : undefined;
  if (event.recipientAuthority && !key) {
    throw new Error("authority-bound system event is missing queue identity");
  }
  return key;
}

export function createPreparedSystemEventAuthorityOwner(params: {
  scope: PreparedAuthorityScope;
  events: readonly SystemEvent[];
}): PreparedSystemEventAuthorityOwner | undefined {
  const pending = new Map<string, PreparedAuthorityBinding>();
  for (const event of params.events) {
    const authorityKey = readPreparedSystemEventAuthorityKey(event);
    if (authorityKey && event.recipientAuthority) {
      pending.set(authorityKey, {
        authority: event.recipientAuthority,
        event,
      });
    }
  }
  return pending.size > 0 ? { scope: params.scope, pending } : undefined;
}

export function resolveFinalSystemEventAdoption(params: {
  prepared: readonly PreparedFormattedSystemEvents[];
  replaceDeliveryIds?: (deliveryIds: readonly string[]) => boolean;
}) {
  const stale: Array<{
    authorityKey: string;
    binding: PreparedAuthorityBinding;
    owner: PreparedSystemEventAuthorityOwner;
  }> = [];
  for (const prepared of params.prepared) {
    const owner = prepared.authorityOwner;
    if (!owner) {
      continue;
    }
    for (const [authorityKey, binding] of owner.pending) {
      if (!isSessionRecipientAuthorityCurrent(owner.scope, binding.authority)) {
        stale.push({ authorityKey, binding, owner });
      }
    }
  }
  if (stale.length > 0) {
    return {
      kind: "settle-stale" as const,
      settle: async () => {
        for (const entry of stale) {
          // Settlement stays bound to the owner that selected this exact queue
          // event; a replacement session cannot redirect it.
          await settleStaleSystemEventAuthority({
            event: entry.binding.event,
            sessionKey: entry.owner.scope.sessionKey,
          });
          entry.owner.pending.delete(entry.authorityKey);
        }
      },
    };
  }

  const isAdoptable = (prepared: PreparedFormattedSystemEvents, authorityKey: string | undefined) =>
    !authorityKey || prepared.authorityOwner?.pending.has(authorityKey);
  const adoptedDeliveries = new Map(
    params.prepared.flatMap((prepared) =>
      prepared.managedDeliveries
        .filter((delivery) => isAdoptable(prepared, delivery.authorityKey))
        .map((delivery) => [delivery.id, delivery] as const),
    ),
  );
  const deliveryIds = [...adoptedDeliveries.keys()];
  const recorderAccepted = params.replaceDeliveryIds?.(deliveryIds) ?? true;
  const deferredBlockKeys = recorderAccepted
    ? undefined
    : new Set(deliveryIds.map((id) => `session-delivery:${id}`));

  return {
    kind: "adopted" as const,
    blocks: params.prepared.flatMap((prepared) =>
      prepared.blocks.filter(
        (block) =>
          isAdoptable(prepared, block.authorityKey) && !deferredBlockKeys?.has(block.key ?? ""),
      ),
    ),
    managedDeliveries: recorderAccepted
      ? adoptedDeliveries
      : new Map<string, PreparedManagedSystemEventDelivery>(),
  };
}
