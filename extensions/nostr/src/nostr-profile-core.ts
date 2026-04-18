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
    if (str === undefined) {
      return undefined;
    }
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
    picture: profile.picture,
    banner: profile.banner,
    website: profile.website,
    nip05: escapeHtml(profile.nip05),
    lud16: escapeHtml(profile.lud16),
  };
}
