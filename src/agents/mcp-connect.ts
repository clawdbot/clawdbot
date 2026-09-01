/**
 * Shared helpers for MCP protocol-era negotiation (2025 legacy vs the
 * 2026-07-28 stateless revision).
 */
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";

/**
 * Bound the 2026-07-28 era probe so a legacy server that never answers
 * pre-initialize requests delays connect by at most this much.
 */
export const MCP_ERA_PROBE_TIMEOUT_MS = 3_000;

/**
 * Negotiate the MCP era per server: speak the 2026-07-28 stateless protocol
 * (no initialize handshake, per-request `_meta`) when the server supports it,
 * and fall back to the byte-equivalent 2025 initialize handshake for older
 * servers.
 */
function buildMcpVersionNegotiation(): VersionNegotiationOptions {
  return {
    mode: "auto",
    probe: { timeoutMs: MCP_ERA_PROBE_TIMEOUT_MS },
  };
}

/**
 * Era negotiation policy per transport kind. HTTP-based transports probe for
 * the 2026-07-28 stateless era and fall back to the 2025 handshake on any
 * non-modern signal. stdio stays pinned to the legacy 2025 handshake: some
 * stdio servers exit on any pre-initialize request, and silent ones would
 * stall every connect for the full probe window.
 */
export function buildMcpVersionNegotiationForTransport(
  transportType: "stdio" | "sse" | "streamable-http" | undefined,
): VersionNegotiationOptions {
  return transportType === "sse" || transportType === "streamable-http"
    ? buildMcpVersionNegotiation()
    : { mode: "legacy" };
}

/**
 * True when a connect failure is specifically an era-negotiation failure — for
 * example a legacy stdio server that exits on the `server/discover` probe
 * instead of answering with an error the SDK could use to fall back to the
 * 2025 handshake on its own.
 */
export function isMcpEraNegotiationFailure(error: unknown): boolean {
  return error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed;
}
