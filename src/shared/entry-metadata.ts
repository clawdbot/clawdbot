import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function resolveEmojiAndHomepage(params: {
  metadata?: { emoji?: string; homepage?: string } | null;
  frontmatter?: {
    emoji?: string;
    homepage?: string;
    website?: string;
    url?: string;
  } | null;
}): { emoji?: string; homepage?: string } {
  const emoji = params.metadata?.emoji ?? params.frontmatter?.emoji;
  const homepageRaw =
    params.metadata?.homepage ??
    params.frontmatter?.homepage ??
    params.frontmatter?.website ??
    params.frontmatter?.url;
  const homepage = normalizeOptionalString(homepageRaw);
  return { ...(emoji ? { emoji } : {}), ...(homepage ? { homepage } : {}) };
}
