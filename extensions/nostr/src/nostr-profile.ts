/**
 * Nostr Profile Management (NIP-01 kind:0)
 *
 * Profile events are "replaceable" - the latest created_at wins.
 * This module handles profile event creation and publishing.
 */

import { finalizeEvent, SimplePool, type Event } from "nostr-tools";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { NostrProfile } from "./config-schema.js";
import { profileToContent } from "./nostr-profile-core.js";
export {
  contentToProfile,
  profileToContent,
  sanitizeProfileForDisplay,
  validateProfile,
  type ProfileContent,
} from "./nostr-profile-core.js";

// ============================================================================
// Types
// ============================================================================

/** Result of a profile publish attempt */
export interface ProfilePublishResult {
  /** Event ID of the published profile */
  eventId: string;
  /** Relays that successfully received the event */
  successes: string[];
  /** Relays that failed with their error messages */
  failures: Array<{ relay: string; error: string }>;
  /** Unix timestamp when the event was created */
  createdAt: number;
}

// ============================================================================
// Event Creation
// ============================================================================

/**
 * Create a signed kind:0 profile event.
 *
 * @param sk - Private key as Uint8Array (32 bytes)
 * @param profile - Profile data to include
 * @param lastPublishedAt - Previous profile timestamp (for monotonic guarantee)
 * @returns Signed Nostr event
 */
export function createProfileEvent(
  sk: Uint8Array,
  profile: NostrProfile,
  lastPublishedAt?: number,
): Event {
  const content = profileToContent(profile);
  const contentJson = JSON.stringify(content);

  // Ensure monotonic timestamp (new event > previous)
  const now = Math.floor(Date.now() / 1000);
  const createdAt = lastPublishedAt !== undefined ? Math.max(now, lastPublishedAt + 1) : now;

  const event = finalizeEvent(
    {
      kind: 0,
      content: contentJson,
      tags: [],
      created_at: createdAt,
    },
    sk,
  );

  return event;
}

// ============================================================================
// Profile Publishing
// ============================================================================

/** Per-relay publish timeout (ms) */
const RELAY_PUBLISH_TIMEOUT_MS = 5000;

/**
 * Publish a profile event to multiple relays.
 *
 * Best-effort: publishes to all relays in parallel, reports per-relay results.
 * Does NOT retry automatically - caller should handle retries if needed.
 *
 * @param pool - SimplePool instance for relay connections
 * @param relays - Array of relay WebSocket URLs
 * @param event - Signed profile event (kind:0)
 * @returns Publish results with successes and failures
 */
async function publishProfileEvent(
  pool: SimplePool,
  relays: string[],
  event: Event,
): Promise<ProfilePublishResult> {
  const successes: string[] = [];
  const failures: Array<{ relay: string; error: string }> = [];

  // Publish to each relay in parallel with timeout
  const publishPromises = relays.map(async (relay) => {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
      });

      await Promise.race([...pool.publish([relay], event), timeoutPromise]);

      successes.push(relay);
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      failures.push({ relay, error: errorMessage });
    }
  });

  await Promise.all(publishPromises);

  return {
    eventId: event.id,
    successes,
    failures,
    createdAt: event.created_at,
  };
}

/**
 * Create and publish a profile event in one call.
 *
 * @param pool - SimplePool instance
 * @param sk - Private key as Uint8Array
 * @param relays - Array of relay URLs
 * @param profile - Profile data
 * @param lastPublishedAt - Previous timestamp for monotonic ordering
 * @returns Publish results
 */
export async function publishProfile(
  pool: SimplePool,
  sk: Uint8Array,
  relays: string[],
  profile: NostrProfile,
  lastPublishedAt?: number,
): Promise<ProfilePublishResult> {
  const event = createProfileEvent(sk, profile, lastPublishedAt);
  return publishProfileEvent(pool, relays, event);
}
