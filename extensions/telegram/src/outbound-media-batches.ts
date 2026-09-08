// Telegram Bot API sendMediaGroup accepts 2–10 items per album.
const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

export async function* planTelegramMediaBatches<T>(params: {
  mediaUrls: readonly string[];
  prepare: (mediaUrl: string, index: number) => Promise<T>;
  canGroup: (item: T, index: number) => boolean;
}): AsyncGenerator<[T, ...T[]]> {
  let photos: [T, ...T[]] | undefined;
  for (const [index, mediaUrl] of params.mediaUrls.entries()) {
    let item: T;
    try {
      item = await params.prepare(mediaUrl, index);
    } catch (error) {
      // Preserve the preceding attachments when loading a later file fails.
      // The caller records their acceptance before this failure propagates.
      if (photos) {
        yield photos;
      }
      throw error;
    }
    if (!params.canGroup(item, index)) {
      if (photos) {
        yield photos;
        photos = undefined;
      }
      yield [item];
      continue;
    }
    if (photos) {
      photos.push(item);
    } else {
      photos = [item];
    }
    if (photos.length === TELEGRAM_MEDIA_GROUP_LIMIT) {
      yield photos;
      photos = undefined;
    }
  }
  if (photos) {
    yield photos;
  }
}
