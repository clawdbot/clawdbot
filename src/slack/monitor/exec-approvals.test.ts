import { describe, expect, it } from "vitest";
import {
  parseApprovalValue,
  getExecApprovalActionIdPrefix,
  SlackExecApprovalHandler,
  type ExecApprovalRequest,
} from "./exec-approvals.js";
import type { SlackExecApprovalConfig } from "../../config/types.slack.js";

// Helper to encode approval values (mirrors internal implementation)
function encodeApprovalValue(
  approvalId: string,
  action: "allow-once" | "allow-always" | "deny",
): string {
  return ["execapproval", encodeURIComponent(approvalId), action].join("|");
}

describe("getExecApprovalActionIdPrefix", () => {
  it("returns the action ID prefix", () => {
    expect(getExecApprovalActionIdPrefix()).toBe("clawdbot_execapproval");
  });
});

describe("parseApprovalValue", () => {
  it("parses valid value", () => {
    const value = encodeApprovalValue("abc-123", "allow-once");
    const result = parseApprovalValue(value);
    expect(result).toEqual({ approvalId: "abc-123", action: "allow-once" });
  });

  it("parses encoded approval id", () => {
    const value = encodeApprovalValue("abc|123", "allow-always");
    const result = parseApprovalValue(value);
    expect(result).toEqual({ approvalId: "abc|123", action: "allow-always" });
  });

  it("handles special characters", () => {
    const value = encodeApprovalValue("test=approval&id", "deny");
    const result = parseApprovalValue(value);
    expect(result).toEqual({ approvalId: "test=approval&id", action: "deny" });
  });

  it("rejects invalid action", () => {
    const value = "execapproval|abc-123|invalid";
    const result = parseApprovalValue(value);
    expect(result).toBeNull();
  });

  it("rejects missing parts", () => {
    expect(parseApprovalValue("execapproval|abc-123")).toBeNull();
    expect(parseApprovalValue("execapproval")).toBeNull();
    expect(parseApprovalValue("")).toBeNull();
  });

  it("rejects undefined input", () => {
    expect(parseApprovalValue(undefined)).toBeNull();
  });

  it("rejects wrong prefix", () => {
    const value = "wrongprefix|abc-123|allow-once";
    const result = parseApprovalValue(value);
    expect(result).toBeNull();
  });

  it("accepts all valid actions", () => {
    expect(parseApprovalValue(encodeApprovalValue("x", "allow-once"))?.action).toBe("allow-once");
    expect(parseApprovalValue(encodeApprovalValue("x", "allow-always"))?.action).toBe(
      "allow-always",
    );
    expect(parseApprovalValue(encodeApprovalValue("x", "deny"))?.action).toBe("deny");
  });
});

describe("roundtrip encoding", () => {
  it("encodes and decodes correctly", () => {
    const approvalId = "test-approval-with|special&chars";
    const action = "allow-always" as const;
    const encoded = encodeApprovalValue(approvalId, action);
    const result = parseApprovalValue(encoded);
    expect(result).toEqual({ approvalId, action });
  });
});

describe("SlackExecApprovalHandler.shouldHandle", () => {
  function createHandler(config: SlackExecApprovalConfig) {
    // Create a minimal mock WebClient
    const mockClient = {} as any;
    return new SlackExecApprovalHandler({
      client: mockClient,
      accountId: "default",
      config,
      cfg: {},
    });
  }

  function createRequest(
    overrides: Partial<ExecApprovalRequest["request"]> = {},
  ): ExecApprovalRequest {
    return {
      id: "test-id",
      request: {
        command: "echo hello",
        cwd: "/home/user",
        host: "gateway",
        agentId: "test-agent",
        sessionKey: "agent:test-agent:slack:123",
        ...overrides,
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000,
    };
  }

  it("returns false when disabled", () => {
    const handler = createHandler({ enabled: false, approvers: ["U123"] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });

  it("returns false when no approvers", () => {
    const handler = createHandler({ enabled: true, approvers: [] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });

  it("returns true with minimal config", () => {
    const handler = createHandler({ enabled: true, approvers: ["U123"] });
    expect(handler.shouldHandle(createRequest())).toBe(true);
  });

  it("filters by agent ID", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["U123"],
      agentFilter: ["allowed-agent"],
    });
    expect(handler.shouldHandle(createRequest({ agentId: "allowed-agent" }))).toBe(true);
    expect(handler.shouldHandle(createRequest({ agentId: "other-agent" }))).toBe(false);
    expect(handler.shouldHandle(createRequest({ agentId: null }))).toBe(false);
  });

  it("filters by session key substring", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["U123"],
      sessionFilter: ["slack"],
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:slack:123" }))).toBe(true);
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:telegram:123" }))).toBe(
      false,
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: null }))).toBe(false);
  });

  it("filters by session key regex", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["U123"],
      sessionFilter: ["^agent:.*:slack:"],
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:slack:123" }))).toBe(true);
    expect(handler.shouldHandle(createRequest({ sessionKey: "other:test:slack:123" }))).toBe(false);
  });

  it("combines agent and session filters", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["U123"],
      agentFilter: ["my-agent"],
      sessionFilter: ["slack"],
    });
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:slack:123",
        }),
      ),
    ).toBe(true);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "other-agent",
          sessionKey: "agent:other:slack:123",
        }),
      ),
    ).toBe(false);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:telegram:123",
        }),
      ),
    ).toBe(false);
  });
});
