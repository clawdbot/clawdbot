import { coerceIdentityValue } from "../../../src/shared/assistant-identity-values.js";
import { normalizeOptionalString } from "./string-coerce.ts";
import {
  isRenderableControlUiAvatarUrl,
  resolveChatAvatarRenderUrl,
} from "./views/agents-utils.ts";

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
  return {
    name:
      coerceIdentityValue(
        typeof input?.name === "string" ? input.name : undefined,
        MAX_LOCAL_USER_NAME,
      ) ?? null,
    avatar: normalizeAvatar(input?.avatar),
  };
}

export function hasLocalUserIdentity(identity: LocalUserIdentity): boolean {
  return Boolean(identity.name || identity.avatar);
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
