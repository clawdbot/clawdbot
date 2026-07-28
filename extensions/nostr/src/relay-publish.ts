// Nostr relay publishing keeps connection and publish failures rejectable.
import type { Event, SimplePool } from "nostr-tools";

const CONNECTION_FAILURE_PREFIX = "connection failure: ";

export async function publishNostrEventToRelay(
  pool: SimplePool,
  relay: string,
  event: Event,
): Promise<string> {
  // SimplePool.publish resolves connection failures as strings, which makes failed
  // relays look successful to callers and prevents sequential failover.
  const publishPromise = pool.publish([relay], event)[0];
  if (!publishPromise) {
    throw new Error(`Failed to create publish promise for relay ${relay}`);
  }
  const result = await publishPromise;
  if (result.startsWith(CONNECTION_FAILURE_PREFIX)) {
    throw new Error(result.slice(CONNECTION_FAILURE_PREFIX.length));
  }
  return result;
}
