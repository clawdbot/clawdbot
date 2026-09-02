// Nostr plugin module implements nostr profile core behavior.
import { type NostrProfile, NostrProfileSchema } from "./config-schema.js";

/** NIP-01 profile content (JSON inside kind:0 event). */
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

/**
 * Convert our config profile schema to NIP-01 content format.
 * Strips undefined fields and validates URLs.
 */
export function profileToContent(profile: NostrProfile): ProfileContent {
  const validated = NostrProfileSchema.parse(profile);

  const content: ProfileContent = {};

  if (validated.name !== undefined) {
    content.name = validated.name;
  }
  if (validated.displayName !== undefined) {
    content.display_name = validated.displayName;
  }
  if (validated.about !== undefined) {
    content.about = validated.about;
  }
  if (validated.picture !== undefined) {
    content.picture = validated.picture;
  }
  if (validated.banner !== undefined) {
    content.banner = validated.banner;
  }
  if (validated.website !== undefined) {
    content.website = validated.website;
  }
  if (validated.nip05 !== undefined) {
    content.nip05 = validated.nip05;
  }
  if (validated.lud16 !== undefined) {
    content.lud16 = validated.lud16;
  }

  return content;
}

/**
 * Convert NIP-01 content format back to our config profile schema.
 * Useful for importing existing profiles from relays.
 */
export function contentToProfile(content: ProfileContent): NostrProfile {
  const profile: NostrProfile = {};

  if (content.name !== undefined) {
    profile.name = content.name;
  }
  if (content.display_name !== undefined) {
    profile.displayName = content.display_name;
  }
  if (content.about !== undefined) {
    profile.about = content.about;
  }
  if (content.picture !== undefined) {
    profile.picture = content.picture;
  }
  if (content.banner !== undefined) {
    profile.banner = content.banner;
  }
  if (content.website !== undefined) {
    profile.website = content.website;
  }
  if (content.nip05 !== undefined) {
    profile.nip05 = content.nip05;
  }
  if (content.lud16 !== undefined) {
    profile.lud16 = content.lud16;
  }

  return profile;
}
