// Msteams plugin module implements html behavior.
import {
  ATTACHMENT_TAG_RE,
  extractHtmlFromAttachment,
  extractInlineImageCandidates,
  IMG_SRC_RE,
  isDownloadableAttachment,
  isLikelyImageAttachment,
  normalizeContentType,
  safeHostForUrl,
} from "./shared.js";
import type { MSTeamsAttachmentLike, MSTeamsHtmlAttachmentSummary } from "./types.js";

/**
 * Extract every `<attachment id="...">` reference from the HTML attachments in
 * the inbound activity. Returns the complete (non-sliced) list; callers that
 * need a capped diagnostic summary can truncate after calling this helper.
 */
export function extractMSTeamsHtmlAttachmentIds(
  attachments: MSTeamsAttachmentLike[] | undefined,
): string[] {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    return [];
  }
  const ids = new Set<string>();
  for (const att of list) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    ATTACHMENT_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null = ATTACHMENT_TAG_RE.exec(html);
    while (match) {
      const id = match[1]?.trim();
      if (id) {
        ids.add(id);
      }
      match = ATTACHMENT_TAG_RE.exec(html);
    }
  }
  return Array.from(ids);
}

export function summarizeMSTeamsHtmlAttachments(
  attachments: MSTeamsAttachmentLike[] | undefined,
): MSTeamsHtmlAttachmentSummary | undefined {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    return undefined;
  }
  let htmlAttachments = 0;
  let imgTags = 0;
  let dataImages = 0;
  let cidImages = 0;
  const srcHosts = new Set<string>();
  let attachmentTags = 0;
  const attachmentIds = new Set<string>();

  for (const att of list) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    htmlAttachments += 1;
    IMG_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = IMG_SRC_RE.exec(html);
    while (match) {
      imgTags += 1;
      const src = match[1]?.trim();
      if (src) {
        if (src.startsWith("data:")) {
          dataImages += 1;
        } else if (src.startsWith("cid:")) {
          cidImages += 1;
        } else {
          srcHosts.add(safeHostForUrl(src));
        }
      }
      match = IMG_SRC_RE.exec(html);
    }

    ATTACHMENT_TAG_RE.lastIndex = 0;
    let attachmentMatch: RegExpExecArray | null = ATTACHMENT_TAG_RE.exec(html);
    while (attachmentMatch) {
      attachmentTags += 1;
      const id = attachmentMatch[1]?.trim();
      if (id) {
        attachmentIds.add(id);
      }
      attachmentMatch = ATTACHMENT_TAG_RE.exec(html);
    }
  }

  if (htmlAttachments === 0) {
    return undefined;
  }
  return {
    htmlAttachments,
    imgTags,
    dataImages,
    cidImages,
    srcHosts: Array.from(srcHosts).slice(0, 5),
    attachmentTags,
    attachmentIds: Array.from(attachmentIds).slice(0, 5),
  };
}

function isAdvertisedFileAttachment(attachment: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(attachment.contentType) ?? "";
  if (
    contentType.startsWith("text/html") ||
    contentType.startsWith("application/vnd.microsoft.card.") ||
    contentType.startsWith("application/vnd.microsoft.teams.card.")
  ) {
    return false;
  }
  return Boolean(
    isDownloadableAttachment(attachment) ||
    isLikelyImageAttachment(attachment) ||
    attachment.name?.trim() ||
    contentType,
  );
}

function countDistinctInlineImages(attachments: MSTeamsAttachmentLike[]): number {
  const seenReferences = new Set<string>();
  let count = 0;
  for (const attachment of attachments) {
    const html = extractHtmlFromAttachment(attachment);
    if (!html) {
      continue;
    }
    IMG_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = IMG_SRC_RE.exec(html);
    while (match) {
      const src = match[1]?.trim();
      if (src?.startsWith("data:")) {
        count += 1;
      } else if (src && !seenReferences.has(src)) {
        seenReferences.add(src);
        count += 1;
      }
      match = IMG_SRC_RE.exec(html);
    }
  }
  return count;
}

function countDistinctInlineCandidates(
  attachments: MSTeamsAttachmentLike[],
  limits?: { maxInlineBytes?: number; maxInlineTotalBytes?: number },
): number {
  const seenUrls = new Set<string>();
  let dataCount = 0;
  for (const candidate of extractInlineImageCandidates(attachments, limits)) {
    if (candidate.kind === "data") {
      dataCount += 1;
    } else {
      seenUrls.add(candidate.url);
    }
  }
  return dataCount + seenUrls.size;
}

function countUnrepresentedHtmlAttachmentIds(attachments: MSTeamsAttachmentLike[]): number {
  const representedIds = new Set<string>();
  for (const attachment of attachments) {
    const contentType = normalizeContentType(attachment.contentType) ?? "";
    if (contentType.startsWith("text/html")) {
      continue;
    }
    const id = attachment.id?.trim();
    if (id) {
      representedIds.add(id);
    }
  }
  return extractMSTeamsHtmlAttachmentIds(attachments).filter((id) => !representedIds.has(id))
    .length;
}

export function resolveMSTeamsInboundAttachmentPresentation(
  attachments: MSTeamsAttachmentLike[] | undefined,
  limits?: { maxInlineBytes?: number; maxInlineTotalBytes?: number },
): { placeholder: string; expectedMediaCount: number } {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    return { placeholder: "", expectedMediaCount: 0 };
  }
  const fileAttachments = list.filter(isAdvertisedFileAttachment);
  const inlinePlaceholderCount = countDistinctInlineCandidates(list, limits);
  const inlineExpectedCount = countDistinctInlineImages(list);
  // Teams HTML uses <attachment> tags as references. A matching attachment
  // entry is the same resource (and may be a card), so count only unmatched
  // IDs that need the Graph/Bot Framework hosted-content fallback.
  const htmlAttachmentCount = countUnrepresentedHtmlAttachmentIds(list);
  const expectedMediaCount = fileAttachments.length + inlineExpectedCount + htmlAttachmentCount;
  if (expectedMediaCount === 0) {
    return { placeholder: "", expectedMediaCount: 0 };
  }
  const totalImages =
    fileAttachments.filter(isLikelyImageAttachment).length + inlinePlaceholderCount;
  if (totalImages > 0) {
    return {
      placeholder: `<media:image>${totalImages > 1 ? ` (${totalImages} images)` : ""}`,
      expectedMediaCount,
    };
  }
  return {
    placeholder: `<media:document>${expectedMediaCount > 1 ? ` (${expectedMediaCount} files)` : ""}`,
    expectedMediaCount,
  };
}
