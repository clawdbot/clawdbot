import { beforeEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { assertGatewaySessionStewardBoundary } from "./session-steward-boundary.js";

describe("Gateway Session Steward boundary", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("rejects cross-agent keys with redacted errors and diagnostics", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => events.push(event));
    const result = assertGatewaySessionStewardBoundary({
      sessionKey: "agent:main:direct:user-1",
      requestedAgentId: "worker",
      surface: "tools.invoke",
      action: "invoke",
      config: { agents: { list: [{ id: "main" }, { id: "worker" }] } },
    });
    stop();

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(result.error.message).toContain('agent "worker"');
    expect(result.error.message).not.toContain("user-1");
    expect(result.boundary).toMatchObject({
      affectedSession: "agent:main:REDACTED",
      ownerAgentId: "main",
      requestedAgentId: "worker",
      agentRelation: "cross_agent",
    });
    expect(JSON.stringify(result)).not.toContain("user-1");
    expect(events.map((event) => event.type)).toEqual([
      "session_steward.boundary_decision",
      "session_steward.boundary_rejected",
    ]);
    expect(JSON.stringify(events)).not.toContain("user-1");
  });

  it("allows global and same-agent boundaries while redacting the selector", () => {
    const global = assertGatewaySessionStewardBoundary({
      sessionKey: "global",
      requestedAgentId: "main",
      surface: "sessions.create",
    });
    expect(global).toMatchObject({
      ok: true,
      boundary: {
        affectedSession: "GLOBAL",
        agentRelation: "unbound",
      },
    });
    const sameAgent = assertGatewaySessionStewardBoundary({
      sessionKey: "Agent:Main:direct:person-123",
      requestedAgentId: "MAIN",
      surface: "sessions.files.get",
      config: { agents: { list: [{ id: "main" }] } },
    });
    expect(sameAgent).toMatchObject({
      ok: true,
      boundary: {
        affectedSession: "agent:main:REDACTED",
        ownerAgentId: "main",
        requestedAgentId: "main",
        agentRelation: "same_agent",
      },
    });
  });

  it("rejects malformed agent keys without exposing their tail", () => {
    const result = assertGatewaySessionStewardBoundary({
      sessionKey: "agent:main:",
      requestedAgentId: "main",
      surface: "sessions.reset",
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("agent:main:");
    expect(JSON.stringify(result)).not.toContain("main:");
  });

  it("rejects agent keys without a session tail", () => {
    const result = assertGatewaySessionStewardBoundary({
      sessionKey: "agent:main",
      requestedAgentId: "main",
      surface: "tools.invoke",
      config: { agents: { list: [{ id: "main" }] } },
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("agent:main");
  });

  it("redacts unconfigured credential-shaped agent ids without exposing them", () => {
    const result = assertGatewaySessionStewardBoundary({
      sessionKey: "agent:sk-abcdefghijk:main",
      requestedAgentId: "sk-abcdefghijk",
      surface: "sessions.files.get",
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-abcdefghijk");
    expect(result).toMatchObject({
      boundary: {
        affectedSession: "agent:UNKNOWN:REDACTED",
        ownerAgentId: "UNKNOWN",
        requestedAgentId: "UNKNOWN",
      },
    });
  });
});
