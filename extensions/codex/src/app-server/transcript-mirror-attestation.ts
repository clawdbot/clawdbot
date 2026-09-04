import { createHash } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

const MIRROR_ORIGIN_META_KEY = "mirrorOrigin" as const;
const MIRROR_SOURCE_FINGERPRINT_META_KEY = "mirrorSourceFingerprint" as const;
const CODEX_APP_SERVER_MIRROR_ORIGIN = "codex-app-server" as const;
const CODEX_META_KEY = "__openclaw";

export function applyCodexTranscriptTaint(
  message: AgentMessage,
  state: { tainted: boolean },
): AgentMessage {
  if (message.role === "user") {
    state.tainted = false;
    return message;
  }
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const metadata = asOptionalRecord(existing);
  state.tainted ||= metadata?.turnTainted === true || metadata?.resultContentSource === "network";
  return message.role === "assistant" && state.tainted
    ? ({ ...message, __openclaw: { ...metadata, turnTainted: true } } as AgentMessage) // SAFETY: Only provider metadata changes.
    : message;
}

export function attachCodexMirrorAttestation(
  message: AgentMessage,
  sourceFingerprint?: string,
): AgentMessage {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const attested: AgentMessage & { [CODEX_META_KEY]: Record<string, unknown> } = {
    ...message,
    [CODEX_META_KEY]: {
      ...baseMeta,
      [MIRROR_ORIGIN_META_KEY]: CODEX_APP_SERVER_MIRROR_ORIGIN,
      ...(sourceFingerprint ? { [MIRROR_SOURCE_FINGERPRINT_META_KEY]: sourceFingerprint } : {}),
    },
  };
  return attested;
}

export function attachCodexMirrorRunId<T extends AgentMessage>(
  message: T,
  runId: string,
  terminal = false,
): T {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const metadata = asOptionalRecord(existing) ?? {};
  const { runTerminal: _staleTerminal, ...current } = metadata;
  return {
    ...message,
    [CODEX_META_KEY]: {
      ...current,
      runId,
      ...(terminal ? { runTerminal: true } : {}),
    },
  } as T; // SAFETY: AgentMessage variants permit provider metadata at runtime; preserve T.
}

export function hasCodexMirrorOrigin(message: AgentMessage): boolean {
  const meta = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  return asOptionalRecord(meta)?.[MIRROR_ORIGIN_META_KEY] === CODEX_APP_SERVER_MIRROR_ORIGIN;
}

export function readCodexMirrorSourceFingerprint(message: AgentMessage): string | undefined {
  const meta = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const value = (meta as Record<string, unknown>)[MIRROR_SOURCE_FINGERPRINT_META_KEY];
  return typeof value === "string" && value ? value : undefined;
}

export function serializeCodexMirrorSourceEvidence(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  return JSON.stringify({
    role: message.role,
    content,
    ...(message.role === "user" ? { upstreamUserText: readUpstreamUserText(message) } : {}),
    ...(message.role === "toolResult"
      ? {
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
        }
      : {}),
  });
}

export function fingerprintCodexMirrorSourceMessage(message: MirroredAgentMessage): string {
  return createHash("sha256")
    .update(serializeCodexMirrorSourceEvidence(message))
    .digest("hex")
    .slice(0, 32);
}
