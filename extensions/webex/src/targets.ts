/**
 * Webex target normalization
 *
 * Handles conversion between various target formats:
 * - Person ID (Y2lz... base64 encoded)
 * - Room ID (Y2lz... base64 encoded)
 * - Email addresses
 * - Prefixed formats (webex:, user:, room:)
 */

import { getWebexRoom, listWebexPeople } from "./api.js";
import type { ResolvedWebexAccount } from "./types.js";

/**
 * Normalize a Webex target identifier
 *
 * Accepts:
 * - webex:Y2lz... (prefixed ID)
 * - user:Y2lz... (person ID prefix)
 * - room:Y2lz... (room ID prefix)
 * - email:user@example.com
 * - user@example.com (bare email)
 * - Y2lz... (raw Webex ID)
 *
 * @returns Normalized ID without prefix, or undefined if invalid
 */
export function normalizeWebexTarget(raw?: string | null): string | undefined {
  if (!raw) return undefined;

  let value = raw.trim();
  if (!value) return undefined;

  // Strip common prefixes
  const prefixes = ["webex:", "user:", "room:", "person:", "email:"];
  for (const prefix of prefixes) {
    if (value.toLowerCase().startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }

  return value || undefined;
}

/**
 * Check if a value looks like a Webex ID
 *
 * Webex IDs are base64-encoded strings that typically start with "Y2lz" (decoded: "cis")
 */
export function isWebexId(value: string): boolean {
  // Webex IDs are base64 and typically start with Y2lz (decoded: "cis")
  // They're usually quite long (80+ chars)
  if (value.length < 40) return false;

  // Check for base64 characters
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;

  // Most Webex IDs start with Y2lz (cis = Cisco)
  return value.startsWith("Y2lz");
}

/**
 * Check if a value looks like an email address
 */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Determine the type of a Webex target
 */
export function getWebexTargetType(value: string): "personId" | "roomId" | "email" | "unknown" {
  const normalized = normalizeWebexTarget(value);
  if (!normalized) return "unknown";

  if (isEmail(normalized)) return "email";

  if (isWebexId(normalized)) {
    // Try to decode and check the type
    try {
      const decoded = Buffer.from(normalized, "base64").toString("utf8");
      if (decoded.includes("PEOPLE") || decoded.includes("PERSON")) return "personId";
      if (decoded.includes("ROOM")) return "roomId";
    } catch {
      // Decoding failed, make a guess
    }

    // Default to personId for unknown Webex IDs
    return "personId";
  }

  return "unknown";
}

/**
 * Format a Webex target for display
 */
export function formatWebexTarget(value: string, type?: "person" | "room"): string {
  const normalized = normalizeWebexTarget(value);
  if (!normalized) return value;

  if (isEmail(normalized)) {
    return normalized.toLowerCase();
  }

  // Truncate long IDs for display
  if (normalized.length > 20) {
    return `${normalized.slice(0, 8)}...${normalized.slice(-8)}`;
  }

  return normalized;
}

/**
 * Normalize an allowFrom entry for comparison
 */
export function normalizeAllowFromEntry(raw: string): string {
  const normalized = normalizeWebexTarget(raw);
  if (!normalized) return raw.toLowerCase().trim();

  // Lowercase emails
  if (isEmail(normalized)) {
    return normalized.toLowerCase();
  }

  // Person IDs are case-sensitive
  return normalized;
}

/**
 * Format an allowFrom entry for storage
 */
export function formatAllowFromEntry(raw: string): string {
  const normalized = normalizeWebexTarget(raw);
  if (!normalized) return raw.trim();

  if (isEmail(normalized)) {
    return normalized.toLowerCase();
  }

  return normalized;
}

/**
 * Resolve a target to a room ID for sending
 *
 * If the target is a person ID or email, this returns undefined
 * (use toPersonId or toPersonEmail in the API call instead).
 *
 * If the target is a room ID, returns it directly.
 */
export async function resolveWebexOutboundTarget(params: {
  account: ResolvedWebexAccount;
  target: string;
}): Promise<{
  roomId?: string;
  toPersonId?: string;
  toPersonEmail?: string;
}> {
  const { account, target } = params;
  const normalized = normalizeWebexTarget(target);

  if (!normalized) {
    throw new Error("Invalid target");
  }

  // Email: send to person by email
  if (isEmail(normalized)) {
    return { toPersonEmail: normalized.toLowerCase() };
  }

  // Try to determine type from ID
  if (isWebexId(normalized)) {
    try {
      const decoded = Buffer.from(normalized, "base64").toString("utf8");
      if (decoded.includes("ROOM")) {
        return { roomId: normalized };
      }
      if (decoded.includes("PEOPLE") || decoded.includes("PERSON")) {
        return { toPersonId: normalized };
      }
    } catch {
      // Decoding failed
    }

    // Try to fetch as room - if it works, it's a room
    try {
      await getWebexRoom(account, normalized);
      return { roomId: normalized };
    } catch {
      // Not a room, assume person
      return { toPersonId: normalized };
    }
  }

  // Unknown format, try as email if it contains @
  if (normalized.includes("@")) {
    return { toPersonEmail: normalized.toLowerCase() };
  }

  // Default: assume person ID
  return { toPersonId: normalized };
}

/**
 * Resolve a person by email to their person ID
 */
export async function resolveWebexPersonByEmail(
  account: ResolvedWebexAccount,
  email: string,
): Promise<string | undefined> {
  try {
    const people = await listWebexPeople(account, { email: email.toLowerCase(), max: 1 });
    return people[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * Build target hints for messaging help text
 */
export function getWebexTargetHints(): string {
  return "<personId|roomId|email@example.com>";
}
