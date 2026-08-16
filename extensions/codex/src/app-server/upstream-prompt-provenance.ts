import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

const UPSTREAM_USER_TEXT_META_KEY = "upstreamUserText" as const;
const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;
const CODEX_META_KEY = "__openclaw";

export function attachCodexMirrorIdentity<T extends AgentMessage>(message: T, identity: string): T {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...message,
    __openclaw: { ...baseMeta, [MIRROR_IDENTITY_META_KEY]: identity },
  };
}

export function readMirrorIdentity(message: AgentMessage): string | undefined {
  const meta = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>)[MIRROR_IDENTITY_META_KEY];
  return typeof id === "string" && id ? id : undefined;
}

export function attachUpstreamUserText<T extends AgentMessage>(message: T, text: string): T {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...message,
    __openclaw: { ...baseMeta, [UPSTREAM_USER_TEXT_META_KEY]: text },
  };
}

export function readUpstreamUserText(message: AgentMessage | undefined): string | undefined {
  const meta = message && CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const text = (meta as Record<string, unknown>)[UPSTREAM_USER_TEXT_META_KEY];
  return typeof text === "string" && text ? text : undefined;
}
