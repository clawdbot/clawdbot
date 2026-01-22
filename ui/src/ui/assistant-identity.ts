const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;

export const DEFAULT_ASSISTANT_NAME = "Assistant";
export const DEFAULT_ASSISTANT_AVATAR = "A";

export type AssistantIdentity = {
  agentId?: string | null;
  name: string;
  avatar: string | null;
};

declare global {
  interface Window {
    __CLAWDBOT_ASSISTANT_NAME__?: string;
    __CLAWDBOT_ASSISTANT_AVATAR__?: string;
  }
}

function coerceIdentityValue(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}

export function normalizeAssistantIdentity(
  input?: Partial<AssistantIdentity> | null,
): AssistantIdentity {
  const name =
    coerceIdentityValue(input?.name, MAX_ASSISTANT_NAME) ?? DEFAULT_ASSISTANT_NAME;
  const avatar = coerceIdentityValue(input?.avatar ?? undefined, MAX_ASSISTANT_AVATAR) ?? null;
  const agentId =
    typeof input?.agentId === "string" && input.agentId.trim()
      ? input.agentId.trim()
      : null;
  return { agentId, name, avatar };
}

export function resolveInjectedAssistantIdentity(): AssistantIdentity {
  if (typeof window === "undefined") {
    return normalizeAssistantIdentity({});
  }
  return normalizeAssistantIdentity({
    name: window.__CLAWDBOT_ASSISTANT_NAME__,
    avatar: window.__CLAWDBOT_ASSISTANT_AVATAR__,
  });
}
