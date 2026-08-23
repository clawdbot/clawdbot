// Control UI module implements user identity behavior.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isRenderableControlUiAvatarUrl, resolveChatAvatarRenderUrl } from "../lib/avatar.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";

const MAX_LOCAL_USER_NAME = 50;
const MAX_LOCAL_USER_TEXT_AVATAR = 16;
const MAX_LOCAL_USER_IMAGE_AVATAR = 2_000_000;

export type LocalUserIdentity = {
  name: string | null;
  avatar: string | null;
};

function normalizeAvatar(value?: string | null): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  if (isRenderableControlUiAvatarUrl(trimmed)) {
    return trimmed.length <= MAX_LOCAL_USER_IMAGE_AVATAR ? trimmed : null;
  }
  if (/[\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed.length <= MAX_LOCAL_USER_TEXT_AVATAR ? trimmed : null;
}

export function normalizeLocalUserIdentity(
  input?: Partial<LocalUserIdentity> | null,
): LocalUserIdentity {
  const name = normalizeOptionalString(input?.name);
  return {
    name: name ? truncateUtf16Safe(name, MAX_LOCAL_USER_NAME) : null,
    avatar: normalizeAvatar(input?.avatar),
  };
}

export function resolveLocalUserName(
  input?: Partial<LocalUserIdentity> | null,
  fallback = "You",
): string {
  return normalizeLocalUserIdentity(input).name ?? fallback;
}

export function resolveLocalUserAvatarUrl(
  input?: Partial<LocalUserIdentity> | null,
): string | null {
  const normalized = normalizeLocalUserIdentity(input);
  return resolveChatAvatarRenderUrl(normalized.avatar, {
    identity: {
      avatar: normalized.avatar ?? undefined,
    },
  });
}

export function resolveLocalUserAvatarText(
  input?: Partial<LocalUserIdentity> | null,
): string | null {
  const normalized = normalizeLocalUserIdentity(input);
  const avatar = normalizeOptionalString(normalized.avatar);
  if (!avatar) {
    return null;
  }
  return resolveLocalUserAvatarUrl(normalized) ? null : avatar;
}
