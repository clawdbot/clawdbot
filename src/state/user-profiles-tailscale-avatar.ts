import { fileTypeFromBuffer } from "file-type";
import { readRemoteMediaBuffer, type FetchLike } from "../media/fetch.js";

export const MAX_USER_PROFILE_AVATAR_BYTES = 512 * 1024;
export const USER_PROFILE_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type UserProfileAvatarMime = (typeof USER_PROFILE_AVATAR_MIME_TYPES)[number];

const TAILSCALE_AVATAR_FETCH_TIMEOUT_MS = 5_000;
const TAILSCALE_AVATAR_MAX_REDIRECTS = 3;

export type TailscaleAvatarFetchOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

function toAvatarMime(value: string | undefined): UserProfileAvatarMime | null {
  return USER_PROFILE_AVATAR_MIME_TYPES.includes(value as UserProfileAvatarMime)
    ? (value as UserProfileAvatarMime)
    : null;
}

export async function fetchTailscaleAvatar(
  url: string,
  options: TailscaleAvatarFetchOptions,
): Promise<{ bytes: Buffer; mime: UserProfileAvatarMime } | null> {
  try {
    const timeoutMs = options.timeoutMs ?? TAILSCALE_AVATAR_FETCH_TIMEOUT_MS;
    const loaded = await readRemoteMediaBuffer({
      url,
      fetchImpl: options.fetchImpl,
      maxBytes: MAX_USER_PROFILE_AVATAR_BYTES,
      maxRedirects: TAILSCALE_AVATAR_MAX_REDIRECTS,
      timeoutMs,
      responseHeaderTimeoutMs: timeoutMs,
      readIdleTimeoutMs: timeoutMs,
      requestInit: { headers: { Accept: USER_PROFILE_AVATAR_MIME_TYPES.join(",") } },
    });
    const mime = toAvatarMime(loaded.contentType);
    const detected = await fileTypeFromBuffer(loaded.buffer);
    return mime && detected?.mime === mime ? { bytes: loaded.buffer, mime } : null;
  } catch {
    return null;
  }
}
