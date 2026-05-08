import type { SessionId } from "@agentclientprotocol/sdk";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { VERSION } from "../version.js";

const ACP_PROVENANCE_MODE_VALUES = ["off", "meta", "meta+receipt"] as const;

type AcpProvenanceMode = (typeof ACP_PROVENANCE_MODE_VALUES)[number];

export function normalizeAcpProvenanceMode(
  value: string | undefined,
): AcpProvenanceMode | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  return (ACP_PROVENANCE_MODE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as AcpProvenanceMode)
    : undefined;
}

export type AcpSession = {
  sessionId: SessionId;
  sessionKey: string;
  ledgerSessionId?: string;
  cwd: string;
  createdAt: number;
  lastTouchedAt: number;
  abortController: AbortController | null;
  activeRunId: string | null;
};

export type AcpServerOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  defaultSessionLabel?: string;
  requireExistingSession?: boolean;
  resetSession?: boolean;
  prefixCwd?: boolean;
  provenanceMode?: AcpProvenanceMode;
  sessionCreateRateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
  verbose?: boolean;
};

export const ACP_AGENT_INFO = {
  name: "openclaw-acp",
  title: "OpenClaw ACP Gateway",
  version: VERSION,
};
