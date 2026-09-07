import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const UPSTREAM_USER_TEXT_META_KEY = "upstreamUserText" as const;
const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;
const CODEX_META_KEY = "__openclaw";

/**
 * Mirror-identity suffix for the per-turn Codex reasoning mirror
 * (`${turnId}:reasoning`). Reasoning is private telemetry, never the turn's
 * final assistant answer, so selectors that pick the terminal/last assistant
 * message must exclude identities ending with this suffix.
 */
export const CODEX_REASONING_MIRROR_IDENTITY_SUFFIX = ":reasoning" as const;

/** True when a message is the per-turn Codex reasoning mirror. */
export function isCodexReasoningMirrorMessage(message: AgentMessage): boolean {
  const identity = readMirrorIdentity(message);
  return identity !== undefined && identity.endsWith(CODEX_REASONING_MIRROR_IDENTITY_SUFFIX);
}

export function attachCodexMirrorIdentity<T extends AgentMessage>(message: T, identity: string): T {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const baseMeta = asOptionalRecord(existing) ?? {};
  return {
    ...message,
    __openclaw: { ...baseMeta, [MIRROR_IDENTITY_META_KEY]: identity },
  };
}

export function readMirrorIdentity(message: AgentMessage): string | undefined {
  const meta = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const record = asOptionalRecord(meta);
  if (!record) {
    return undefined;
  }
  const id = record[MIRROR_IDENTITY_META_KEY];
  return typeof id === "string" && id ? id : undefined;
}

export function attachUpstreamUserText<T extends AgentMessage>(message: T, text: string): T {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const baseMeta = asOptionalRecord(existing) ?? {};
  return {
    ...message,
    __openclaw: { ...baseMeta, [UPSTREAM_USER_TEXT_META_KEY]: text },
  };
}

export function readUpstreamUserText(message: AgentMessage | undefined): string | undefined {
  const meta = message && CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const record = asOptionalRecord(meta);
  if (!record) {
    return undefined;
  }
  const text = record[UPSTREAM_USER_TEXT_META_KEY];
  return typeof text === "string" && text ? text : undefined;
}
