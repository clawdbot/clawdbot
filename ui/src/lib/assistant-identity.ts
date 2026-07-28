// Control UI module implements assistant identity behavior.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isRenderableAvatarImageDataUrl } from "../../../src/shared/avatar-limits.js";
import { normalizeOptionalString } from "./string-coerce.ts";

// Short text/emoji avatars (e.g. "A", "PS", "🦞"). Anything longer that is not
// a renderable image URL is dropped during normalization.
const MAX_ASSISTANT_TEXT_AVATAR = 64;
const ASSISTANT_IDENTITY_LIMITS = {
  name: 50,
  avatarSource: 500,
  avatarReason: 200,
} as const;
type AssistantIdentityField = keyof typeof ASSISTANT_IDENTITY_LIMITS;
// Mirrors lib/agents/display avatar URL handling. Keep this local so assistant
// identity loading does not import agent display helpers or Lit templates.
const SAME_ORIGIN_AVATAR_URL_RE = /^\/(?!\/)/;
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

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

function normalizeAssistantValue(
  field: AssistantIdentityField,
  value: string | null | undefined,
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? truncateUtf16Safe(trimmed, ASSISTANT_IDENTITY_LIMITS[field]) : undefined;
}

function normalizeAssistantAvatar(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  if (isRenderableAvatarImageDataUrl(trimmed) || SAME_ORIGIN_AVATAR_URL_RE.test(trimmed)) {
    return trimmed;
  }
  if (URI_SCHEME_RE.test(trimmed)) {
    return null;
  }
  if (/[\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed.length <= MAX_ASSISTANT_TEXT_AVATAR ? trimmed : null;
}

export function normalizeAssistantIdentity(
  input?: Partial<AssistantIdentity> | null,
): AssistantIdentity {
  const name = normalizeAssistantValue("name", input?.name) ?? DEFAULT_ASSISTANT_NAME;
  const avatar = normalizeAssistantAvatar(input?.avatar);
  const avatarSource = normalizeAssistantValue("avatarSource", input?.avatarSource) ?? null;
  const avatarStatus =
    input?.avatarStatus === "none" ||
    input?.avatarStatus === "local" ||
    input?.avatarStatus === "remote" ||
    input?.avatarStatus === "data"
      ? input.avatarStatus
      : null;
  const avatarReason = normalizeAssistantValue("avatarReason", input?.avatarReason) ?? null;
  const agentId =
    typeof input?.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : null;
  return { agentId, name, avatar, avatarSource, avatarStatus, avatarReason };
}
