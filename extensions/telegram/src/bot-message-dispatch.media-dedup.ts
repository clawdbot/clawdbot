// Keep sent-block media out of both delivery fields so outbound planning cannot restore it.
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
  const mediaUrl = payload.mediaUrl;
  return {
    ...payload,
    mediaUrls: remainingMedia,
    mediaUrl: mediaUrl && sentBlockMediaUrls.has(mediaUrl.trim()) ? undefined : mediaUrl,
  };
}
