import { AGENT_METHODS, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { normalizeAcpInitializeProtocolVersion } from "./protocol-version.js";

describe("normalizeAcpInitializeProtocolVersion", () => {
  it("normalizes date-style client versions before SDK validation", () => {
    expect(
      normalizeAcpInitializeProtocolVersion({
        jsonrpc: "2.0",
        id: 1,
        method: AGENT_METHODS.initialize,
        params: { protocolVersion: "2026-01-01", clientCapabilities: {} },
      }),
    ).toMatchObject({
      params: { protocolVersion: PROTOCOL_VERSION },
    });
  });

  it("leaves valid versions and unrelated messages unchanged", () => {
    const valid = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: AGENT_METHODS.initialize,
      params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
    };
    const unrelated = { jsonrpc: "2.0" as const, method: "session/cancel", params: {} };
    const newerNumericVersion = {
      ...valid,
      params: { ...valid.params, protocolVersion: 2 },
    };

    expect(normalizeAcpInitializeProtocolVersion(valid)).toBe(valid);
    expect(normalizeAcpInitializeProtocolVersion(newerNumericVersion)).toBe(newerNumericVersion);
    expect(normalizeAcpInitializeProtocolVersion(unrelated)).toBe(unrelated);
  });

  it("leaves malformed non-date versions for SDK validation", () => {
    for (const protocolVersion of [1.5, "not-a-date", null]) {
      const message = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: AGENT_METHODS.initialize,
        params: { protocolVersion, clientCapabilities: {} },
      };
      expect(normalizeAcpInitializeProtocolVersion(message)).toBe(message);
    }
  });
});
