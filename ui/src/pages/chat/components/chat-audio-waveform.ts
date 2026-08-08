export const CHAT_AUDIO_WAVEFORM_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_AUDIO_WAVEFORM_SAMPLE_RATE = 16_000;
const CHAT_AUDIO_WAVEFORM_MAX_DURATION_SECONDS = 5 * 60;
const CHAT_AUDIO_WAVEFORM_BUCKET_COUNT = 96;

type ChatAudioBufferLike = {
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
};

export type CachedChatAudioBlob = {
  blobUrl: string;
  sizeBytes: number;
  peaks?: readonly number[];
  durationSeconds?: number;
};

type ChatAudioBlobCacheEntry = CachedChatAudioBlob & { retainCount: number };

const chatAudioBlobCache = new Map<string, ChatAudioBlobCacheEntry>();
const CHAT_AUDIO_BLOB_CACHE_MAX_ENTRIES = 32;
const CHAT_AUDIO_BLOB_CACHE_MAX_BYTES = 48 * 1024 * 1024;

export function shouldFetchChatAudioWaveform(params: {
  sizeBytes?: number;
  durationSeconds?: number;
}): boolean {
  return (
    params.durationSeconds !== undefined &&
    Number.isFinite(params.durationSeconds) &&
    params.durationSeconds >= 0 &&
    params.durationSeconds <= CHAT_AUDIO_WAVEFORM_MAX_DURATION_SECONDS &&
    (params.sizeBytes === undefined ||
      (Number.isFinite(params.sizeBytes) &&
        params.sizeBytes >= 0 &&
        params.sizeBytes <= CHAT_AUDIO_WAVEFORM_MAX_BYTES))
  );
}

export function canDecodeChatAudioWaveform(params: {
  sizeBytes: number;
  durationSeconds?: number;
}): boolean {
  return (
    Number.isFinite(params.sizeBytes) &&
    params.sizeBytes >= 0 &&
    params.sizeBytes <= CHAT_AUDIO_WAVEFORM_MAX_BYTES &&
    params.durationSeconds !== undefined &&
    Number.isFinite(params.durationSeconds) &&
    params.durationSeconds >= 0 &&
    params.durationSeconds <= CHAT_AUDIO_WAVEFORM_MAX_DURATION_SECONDS
  );
}

export function computeChatAudioWaveformPeaks(
  buffer: ChatAudioBufferLike,
  bucketCount = CHAT_AUDIO_WAVEFORM_BUCKET_COUNT,
): number[] {
  const count = Math.max(1, Math.floor(bucketCount));
  if (buffer.length <= 0 || buffer.numberOfChannels <= 0) {
    return Array.from({ length: count }, () => 0);
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel),
  );
  const peaks = Array.from({ length: count }, () => 0);
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor((bucket * buffer.length) / count);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * buffer.length) / count));
    let peak = 0;
    for (const samples of channels) {
      for (let index = start; index < Math.min(end, samples.length); index += 1) {
        peak = Math.max(peak, Math.abs(samples[index] ?? 0));
      }
    }
    peaks[bucket] = peak;
  }
  const maximum = Math.max(...peaks);
  return maximum > 0 ? peaks.map((peak) => peak / maximum) : peaks;
}

function trimChatAudioBlobCache(): void {
  while (
    chatAudioBlobCache.size > CHAT_AUDIO_BLOB_CACHE_MAX_ENTRIES ||
    [...chatAudioBlobCache.values()].reduce((total, entry) => total + entry.sizeBytes, 0) >
      CHAT_AUDIO_BLOB_CACHE_MAX_BYTES
  ) {
    const evictable = [...chatAudioBlobCache].find(([, entry]) => entry.retainCount === 0);
    if (!evictable) {
      return;
    }
    const [cacheKey, entry] = evictable;
    chatAudioBlobCache.delete(cacheKey);
    URL.revokeObjectURL(entry.blobUrl);
  }
}

function makeRoomForChatAudioBlob(sizeBytes: number): boolean {
  if (sizeBytes > CHAT_AUDIO_BLOB_CACHE_MAX_BYTES) {
    return false;
  }
  const cachedBytes = () =>
    [...chatAudioBlobCache.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
  while (
    chatAudioBlobCache.size + 1 > CHAT_AUDIO_BLOB_CACHE_MAX_ENTRIES ||
    cachedBytes() + sizeBytes > CHAT_AUDIO_BLOB_CACHE_MAX_BYTES
  ) {
    const evictable = [...chatAudioBlobCache].find(([, entry]) => entry.retainCount === 0);
    if (!evictable) {
      return false;
    }
    const [cacheKey, entry] = evictable;
    chatAudioBlobCache.delete(cacheKey);
    URL.revokeObjectURL(entry.blobUrl);
  }
  return true;
}

export function retainCachedChatAudioBlob(
  cacheKey: string,
): { value: CachedChatAudioBlob; release: () => void } | null {
  const entry = chatAudioBlobCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  chatAudioBlobCache.delete(cacheKey);
  chatAudioBlobCache.set(cacheKey, entry);
  entry.retainCount += 1;
  let released = false;
  return {
    value: entry,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = chatAudioBlobCache.get(cacheKey);
      if (current && current.retainCount > 0) {
        current.retainCount -= 1;
      }
      trimChatAudioBlobCache();
    },
  };
}

export function cacheAndRetainChatAudioBlob(
  cacheKey: string,
  value: CachedChatAudioBlob,
): { value: CachedChatAudioBlob; release: () => void } | null {
  const previous = chatAudioBlobCache.get(cacheKey);
  if (previous) {
    if (previous.blobUrl !== value.blobUrl) {
      URL.revokeObjectURL(value.blobUrl);
    }
    return retainCachedChatAudioBlob(cacheKey)!;
  }
  if (!makeRoomForChatAudioBlob(value.sizeBytes)) {
    URL.revokeObjectURL(value.blobUrl);
    return null;
  }
  const entry = { ...value, retainCount: 1 };
  chatAudioBlobCache.set(cacheKey, entry);
  trimChatAudioBlobCache();
  let released = false;
  return {
    value: entry,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = chatAudioBlobCache.get(cacheKey);
      if (current && current.retainCount > 0) {
        current.retainCount -= 1;
      }
      trimChatAudioBlobCache();
    },
  };
}
