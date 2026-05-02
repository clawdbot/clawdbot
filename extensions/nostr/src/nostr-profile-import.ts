/**
 * Nostr Profile Import
 *
 * Fetches and verifies kind:0 profile events from relays.
 * Used to import existing profiles before editing.
 */

import { SimplePool, verifyEvent, type Event } from "nostr-tools";
import type { NostrProfile } from "./config-schema.js";
import { validateUrlSafety } from "./nostr-profile-url-safety.js";
import { contentToProfile, type ProfileContent } from "./nostr-profile.js";

// ============================================================================
// Types
// ============================================================================

interface ProfileImportResult {
  /** Whether the import was successful */
  ok: boolean;
  /** The imported profile (if found and valid) */
  profile?: NostrProfile;
  /** The raw event (for advanced users) */
  event?: {
    id: string;
    pubkey: string;
    created_at: number;
  };
  /** Error message if import failed */
  error?: string;
  /** Which relays responded */
  relaysQueried: string[];
  /** Which relay provided the winning event */
  sourceRelay?: string;
}

interface ProfileImportOptions {
  /** The public key to fetch profile for */
  pubkey: string;
  /** Relay URLs to query */
  relays: string[];
  /** Timeout per relay in milliseconds (default: 5000) */
  timeoutMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 5000;

// ============================================================================
// Profile Import
// ============================================================================

/**
 * Sanitize URLs in an imported profile to prevent SSRF attacks.
 * Removes any URLs that don't pass SSRF validation.
 */
function sanitizeProfileUrls(profile: NostrProfile): NostrProfile {
  const result = { ...profile };
  const urlFields = ["picture", "banner", "website"] as const;

  for (const field of urlFields) {
    const value = result[field];
    if (value && typeof value === "string") {
      const validation = validateUrlSafety(value);
      if (!validation.ok) {
        // Remove unsafe URL
        delete result[field];
      }
    }
  }

  return result;
}

/**
 * Fetch the latest kind:0 profile event for a pubkey from relays.
 *
 * - Queries all relays in parallel
 * - Takes the event with the highest created_at
 * - Verifies the event signature
 * - Parses and returns the profile
 */
export async function importProfileFromRelays(
  opts: ProfileImportOptions,
): Promise<ProfileImportResult> {
  const { pubkey, relays, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    return {
      ok: false,
      error: "Invalid pubkey format (must be 64 hex characters)",
      relaysQueried: [],
    };
  }

  if (relays.length === 0) {
    return {
      ok: false,
      error: "No relays configured",
      relaysQueried: [],
    };
  }

  const pool = new SimplePool();
  const relaysQueried: string[] = [];

  try {
    // Query all relays for kind:0 events from this pubkey
    const events: Array<{ event: Event; relay: string }> = [];

    // Create timeout promise
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    });

    // Create subscription promise
    const subscriptionPromise = new Promise<void>((resolve) => {
      let completed = 0;

      for (const relay of relays) {
        relaysQueried.push(relay);

        const sub = pool.subscribeMany(
          [relay],
          [
            {
              kinds: [0],
              authors: [pubkey],
              limit: 1,
            },
          ] as unknown as Parameters<typeof pool.subscribeMany>[1],
          {
            onevent(event) {
              events.push({ event, relay });
            },
            oneose() {
              completed++;
              if (completed >= relays.length) {
                resolve();
              }
            },
            onclose() {
              completed++;
              if (completed >= relays.length) {
                resolve();
              }
            },
          },
        );

        // Clean up subscription after timeout
        setTimeout(() => {
          sub.close();
        }, timeoutMs);
      }
    });

    // Wait for either all relays to respond or timeout
    await Promise.race([subscriptionPromise, timeoutPromise]);

    // No events found
    if (events.length === 0) {
      return {
        ok: false,
        error: "No profile found on any relay",
        relaysQueried,
      };
    }

    // Find the event with the highest created_at (newest wins for replaceable events)
    let bestEvent: { event: Event; relay: string } | null = null;
    for (const item of events) {
      if (!bestEvent || item.event.created_at > bestEvent.event.created_at) {
        bestEvent = item;
      }
    }

    if (!bestEvent) {
      return {
        ok: false,
        error: "No valid profile event found",
        relaysQueried,
      };
    }

    // Verify the event signature
    const isValid = verifyEvent(bestEvent.event);
    if (!isValid) {
      return {
        ok: false,
        error: "Profile event has invalid signature",
        relaysQueried,
        sourceRelay: bestEvent.relay,
      };
    }

    // Parse the profile content
    let content: ProfileContent;
    try {
      content = JSON.parse(bestEvent.event.content) as ProfileContent;
    } catch {
      return {
        ok: false,
        error: "Profile event has invalid JSON content",
        relaysQueried,
        sourceRelay: bestEvent.relay,
      };
    }

    // Convert to our profile format
    const profile = contentToProfile(content);

    // Sanitize URLs from imported profile to prevent SSRF when auto-merging
    const sanitizedProfile = sanitizeProfileUrls(profile);

    return {
      ok: true,
      profile: sanitizedProfile,
      event: {
        id: bestEvent.event.id,
        pubkey: bestEvent.event.pubkey,
        created_at: bestEvent.event.created_at,
      },
      relaysQueried,
      sourceRelay: bestEvent.relay,
    };
  } finally {
    pool.close(relays);
  }
}

/**
 * Merge imported profile with local profile.
 *
 * Strategy:
 * - For each field, prefer local if set, otherwise use imported
 * - This preserves user customizations while filling in missing data
 */
export function mergeProfiles(
  local: NostrProfile | undefined,
  imported: NostrProfile | undefined,
): NostrProfile {
  if (!imported) {
    return local ?? {};
  }
  if (!local) {
    return imported;
  }

  return {
    name: local.name ?? imported.name,
    displayName: local.displayName ?? imported.displayName,
    about: local.about ?? imported.about,
    picture: local.picture ?? imported.picture,
    banner: local.banner ?? imported.banner,
    website: local.website ?? imported.website,
    nip05: local.nip05 ?? imported.nip05,
    lud16: local.lud16 ?? imported.lud16,
  };
}
