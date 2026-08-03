import { createHash } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

const MIRROR_ORIGIN_META_KEY = "mirrorOrigin" as const;
const MIRROR_SOURCE_FINGERPRINT_META_KEY = "mirrorSourceFingerprint" as const;
const CODEX_APP_SERVER_MIRROR_ORIGIN = "codex-app-server" as const;

export function attachCodexMirrorAttestation(
  message: AgentMessage,
  sourceFingerprint?: string,
): AgentMessage {
  const record = message as unknown as Record<string, unknown>;
  const existing = record["__openclaw"];
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...baseMeta,
      [MIRROR_ORIGIN_META_KEY]: CODEX_APP_SERVER_MIRROR_ORIGIN,
      ...(sourceFingerprint ? { [MIRROR_SOURCE_FINGERPRINT_META_KEY]: sourceFingerprint } : {}),
    },
  } as unknown as AgentMessage;
}

export function readCodexMirrorSourceFingerprint(message: AgentMessage): string | undefined {
  const meta = (message as unknown as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const value = (meta as Record<string, unknown>)[MIRROR_SOURCE_FINGERPRINT_META_KEY];
  return typeof value === "string" && value ? value : undefined;
}

export function serializeCodexMirrorSourceEvidence(message: AgentMessage): string {
  const record = message as unknown as Record<string, unknown>;
  return JSON.stringify({
    role: message.role,
    content: record.content,
    ...(message.role === "user" ? { upstreamUserText: readUpstreamUserText(message) } : {}),
    ...(message.role === "toolResult"
      ? {
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          isError: record.isError === true,
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
