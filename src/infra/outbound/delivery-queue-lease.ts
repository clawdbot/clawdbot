import { PLATFORM_SEND_OWNER_LEASE_MS } from "../delivery-queue-sqlite-claim.js";

const PLATFORM_SEND_OWNER_HEARTBEAT_MS = Math.floor(PLATFORM_SEND_OWNER_LEASE_MS / 3);

type DeliveryProducerLease = {
  signal: AbortSignal;
  stop: () => void;
};

class StableDeliveryProducerLeaseLostError extends Error {
  override name = "StableDeliveryProducerLeaseLostError";
}

function lostProducerLeaseError(id: string, cause?: unknown): Error {
  return new StableDeliveryProducerLeaseLostError(
    `Stable delivery platform claim was lost: ${id}`,
    { cause },
  );
}

/** Maintains one already-acquired stable producer claim during fallible preparation and send. */
export async function startDeliveryProducerLease(params: {
  id: string;
  renew: () => Promise<number | undefined>;
}): Promise<DeliveryProducerLease> {
  let confirmedExpiresAt: number;
  try {
    const initialExpiry = await params.renew();
    if (initialExpiry === undefined || initialExpiry <= Date.now()) {
      throw lostProducerLeaseError(params.id);
    }
    confirmedExpiresAt = initialExpiry;
  } catch (error) {
    if (error instanceof StableDeliveryProducerLeaseLostError) {
      throw error;
    }
    throw lostProducerLeaseError(params.id, error);
  }

  const lost = new AbortController();
  let stopped = false;
  let renewing = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const abortLost = (cause?: unknown): void => {
    if (!stopped && !lost.signal.aborted) {
      lost.abort(lostProducerLeaseError(params.id, cause));
    }
  };
  const scheduleExpiry = (): void => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    expiryTimer = setTimeout(() => abortLost(), Math.max(1, confirmedExpiresAt - Date.now()));
    expiryTimer.unref?.();
  };
  const renew = async (): Promise<void> => {
    if (stopped || renewing || lost.signal.aborted) {
      return;
    }
    renewing = true;
    try {
      const expiresAt = await params.renew();
      if (stopped) {
        return;
      }
      if (expiresAt === undefined) {
        abortLost();
        return;
      }
      confirmedExpiresAt = expiresAt;
      scheduleExpiry();
    } catch (error) {
      // A transient storage failure does not revoke the last confirmed lease.
      // Its expiry timer remains authoritative while later heartbeats retry.
      if (!stopped && Date.now() >= confirmedExpiresAt) {
        abortLost(error);
      }
    } finally {
      renewing = false;
    }
  };

  scheduleExpiry();
  const heartbeat = setInterval(() => void renew(), PLATFORM_SEND_OWNER_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    signal: lost.signal,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(heartbeat);
      if (expiryTimer) {
        clearTimeout(expiryTimer);
      }
    },
  };
}
