import { coerceIdentityValue } from "../../../src/shared/assistant-identity-values.js";

const MAX_ASSISTANT_NAME = 50;
// Short text/emoji avatars (e.g. "A", "PS", "🦞"). Anything longer that is not
// a renderable image URL is dropped during normalization.
const MAX_ASSISTANT_TEXT_AVATAR = 64;
// Image-bearing avatars (data: URLs, same-origin Control UI routes). Sized to
// match MAX_LOCAL_USER_IMAGE_AVATAR so an uploaded image data URL survives
// round-tripping through config without truncation.
const MAX_ASSISTANT_IMAGE_AVATAR = 2_000_000;
const MAX_ASSISTANT_AVATAR_SOURCE = 500;
const MAX_ASSISTANT_AVATAR_REASON = 200;
// Mirrors agents-utils.CONTROL_UI_AVATAR_URL_RE — duplicated locally to keep
// this module free of UI view imports (avoids an import cycle).
const RENDERABLE_AVATAR_URL_RE = /^(data:image\/|\/(?!\/))/i;

const DEFAULT_ASSISTANT_NAME = "Assistant";
export const DEFAULT_ASSISTANT_AVATAR = "A";

export type AssistantIdentity = {
  agentId?: string | null;
  name: string;
  avatar: string | null;
  avatarSource?: string | null;
  avatarStatus?: "none" | "local" | "remote" | "data" | null;
  avatarReason?: string | null;
};

function normalizeAssistantAvatar(value: string | null | undefined): string | null {
  const trimmed = coerceIdentityValue(value ?? undefined, MAX_ASSISTANT_IMAGE_AVATAR);
  if (!trimmed) {
    return null;
  }
  if (RENDERABLE_AVATAR_URL_RE.test(trimmed)) {
    return trimmed;
  }
  if (/[\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed.length <= MAX_ASSISTANT_TEXT_AVATAR ? trimmed : null;
}

export function normalizeAssistantIdentity(
  input?: Partial<AssistantIdentity> | null,
): AssistantIdentity {
  const name = coerceIdentityValue(input?.name, MAX_ASSISTANT_NAME) ?? DEFAULT_ASSISTANT_NAME;
  const avatar = normalizeAssistantAvatar(input?.avatar);
  const avatarSource =
    coerceIdentityValue(input?.avatarSource ?? undefined, MAX_ASSISTANT_AVATAR_SOURCE) ?? null;
  const avatarStatus =
    input?.avatarStatus === "none" ||
    input?.avatarStatus === "local" ||
    input?.avatarStatus === "remote" ||
    input?.avatarStatus === "data"
      ? input.avatarStatus
      : null;
  const avatarReason =
    coerceIdentityValue(input?.avatarReason ?? undefined, MAX_ASSISTANT_AVATAR_REASON) ?? null;
  const agentId =
    typeof input?.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : null;
  return { agentId, name, avatar, avatarSource, avatarStatus, avatarReason };
}
