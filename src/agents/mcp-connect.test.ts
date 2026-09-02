import { describe, expect, it } from "vitest";
import { MCP_ERA_PROBE_TIMEOUT_MS, buildMcpVersionNegotiationForTransport } from "./mcp-connect.js";

describe("MCP protocol-era negotiation scope", () => {
  it.each(["sse", "streamable-http"] as const)(
    "probes HTTP transport %s for the stateless era",
    (transportType) => {
      expect(buildMcpVersionNegotiationForTransport(transportType)).toEqual({
        mode: "auto",
        probe: { timeoutMs: MCP_ERA_PROBE_TIMEOUT_MS },
      });
    },
  );

  it.each(["stdio", undefined] as const)(
    "keeps %s transport on the legacy handshake",
    (transportType) => {
      expect(buildMcpVersionNegotiationForTransport(transportType)).toEqual({
        mode: "legacy",
      });
    },
  );
});
