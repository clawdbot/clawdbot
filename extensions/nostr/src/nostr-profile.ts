/**
 * Nostr Profile Management (NIP-01 kind:0)
 *
 * Profile events are "replaceable" - the latest created_at wins.
 * This module handles profile event creation and publishing.
 */

import { finalizeEvent, SimplePool, type Event } from "nostr-tools";
import { type NostrProfile, NostrProfileSchema } from "./config-schema.js";

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

/** NIP-01 profile content (JSON inside kind:0 event) */
export interface ProfileContent {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
}

// ============================================================================
// Profile Content Conversion
// ============================================================================

/**
 * Convert our config profile schema to NIP-01 content format.
 * Strips undefined fields and validates URLs.
 */
export function profileToContent(profile: NostrProfile): ProfileContent {
  const validated = NostrProfileSchema.parse(profile);

  const content: ProfileContent = {};

  if (validated.name !== undefined) content.name = validated.name;
  if (validated.displayName !== undefined) content.display_name = validated.displayName;
  if (validated.about !== undefined) content.about = validated.about;
  if (validated.picture !== undefined) content.picture = validated.picture;
  if (validated.banner !== undefined) content.banner = validated.banner;
  if (validated.website !== undefined) content.website = validated.website;
  if (validated.nip05 !== undefined) content.nip05 = validated.nip05;
  if (validated.lud16 !== undefined) content.lud16 = validated.lud16;

  return content;
}

/**
 * Convert NIP-01 content format back to our config profile schema.
 * Useful for importing existing profiles from relays.
 */
export function contentToProfile(content: ProfileContent): NostrProfile {
  const profile: NostrProfile = {};

  if (content.name !== undefined) profile.name = content.name;
  if (content.display_name !== undefined) profile.displayName = content.display_name;
  if (content.about !== undefined) profile.about = content.about;
  if (content.picture !== undefined) profile.picture = content.picture;
  if (content.banner !== undefined) profile.banner = content.banner;
  if (content.website !== undefined) profile.website = content.website;
  if (content.nip05 !== undefined) profile.nip05 = content.nip05;
  if (content.lud16 !== undefined) profile.lud16 = content.lud16;

  return profile;
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
  lastPublishedAt?: number
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
    sk
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
export async function publishProfileEvent(
  pool: SimplePool,
  relays: string[],
  event: Event
): Promise<ProfilePublishResult> {
  const successes: string[] = [];
  const failures: Array<{ relay: string; error: string }> = [];

  // Publish to each relay in parallel with timeout
  const publishPromises = relays.map(async (relay) => {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
      });

      // pool.publish returns Promise<string>[], get the first promise
      await Promise.race([pool.publish([relay], event)[0], timeoutPromise]);

      successes.push(relay);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
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
  lastPublishedAt?: number
): Promise<ProfilePublishResult> {
  const event = createProfileEvent(sk, profile, lastPublishedAt);
  return publishProfileEvent(pool, relays, event);
}

// ============================================================================
// Profile Validation Helpers
// ============================================================================

/**
 * Validate a profile without throwing (returns result object).
 */
export function validateProfile(profile: unknown): {
  valid: boolean;
  profile?: NostrProfile;
  errors?: string[];
} {
  const result = NostrProfileSchema.safeParse(profile);

  if (result.success) {
    return { valid: true, profile: result.data };
  }

  return {
    valid: false,
    errors: result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
  };
}

/**
 * Sanitize profile text fields to prevent XSS when displaying in UI.
 * Escapes HTML special characters.
 */
export function sanitizeProfileForDisplay(profile: NostrProfile): NostrProfile {
  const escapeHtml = (str: string | undefined): string | undefined => {
    if (str === undefined) return undefined;
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  return {
    name: escapeHtml(profile.name),
    displayName: escapeHtml(profile.displayName),
    about: escapeHtml(profile.about),
    picture: profile.picture, // URLs already validated by schema
    banner: profile.banner,
    website: profile.website,
    nip05: escapeHtml(profile.nip05),
    lud16: escapeHtml(profile.lud16),
  };
}
