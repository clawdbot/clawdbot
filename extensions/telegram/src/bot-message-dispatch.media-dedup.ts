export function deduplicateBlockSentMedia<
  T extends { mediaUrl?: string; mediaUrls?: string[]; text?: string },
>(payload: T, sentBlockMediaUrls: ReadonlySet<string>): T | undefined {
  if (!payload.mediaUrls?.length || sentBlockMediaUrls.size === 0) {
    return payload;
  }
  const remainingMedia = payload.mediaUrls.filter((url) => !sentBlockMediaUrls.has(url));
  if (remainingMedia.length === payload.mediaUrls.length) {
    return payload;
  }
  if (remainingMedia.length === 0 && !payload.text) {
    return undefined;
  }
  return {
    ...payload,
    mediaUrls: remainingMedia,
    mediaUrl: remainingMedia.length === 0 ? undefined : payload.mediaUrl,
  };
}
