import { describe, expect, it } from "vitest";
import { parseExecApprovalRequested, parsePluginApprovalRequested } from "./exec-approval.ts";

describe("parseExecApprovalRequested", () => {
  it("returns entries with kind 'exec'", () => {
    const result = parseExecApprovalRequested({
      id: "exec-1",
      request: { command: "rm -rf /" },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });
    expect(result?.kind).toBe("exec");
    expect(result?.request.command).toBe("rm -rf /");
  });
});

describe("parsePluginApprovalRequested", () => {
  // Matches the actual gateway broadcast shape: title/description/severity/pluginId
  // are nested inside payload.request (PluginApprovalRequestPayload)
  const validPayload = {
    id: "plugin-1",
    createdAtMs: 1000,
    expiresAtMs: 120_000,
    request: {
      title: "Dangerous command detected",
      description: "chmod 777 script.sh modifies file permissions",
      severity: "high",
      pluginId: "sage",
      agentId: "agent-1",
      sessionKey: "sess-1",
    },
  };

  it("parses a valid payload", () => {
    const result = parsePluginApprovalRequested(validPayload);
    expect(result?.kind).toBe("plugin");
    expect(result?.pluginTitle).toBe("Dangerous command detected");
    expect(result?.pluginDescription).toBe("chmod 777 script.sh modifies file permissions");
    expect(result?.pluginSeverity).toBe("high");
    expect(result?.pluginId).toBe("sage");
    expect(result?.request.command).toBe("Dangerous command detected");
    expect(result?.request.agentId).toBe("agent-1");
    expect(result?.request.sessionKey).toBe("sess-1");
    expect(result?.createdAtMs).toBe(1000);
    expect(result?.expiresAtMs).toBe(120_000);
  });

  it("returns null when title is missing from request", () => {
    const {
      request: { title: _, ...restRequest },
      ...rest
    } = validPayload;
    expect(parsePluginApprovalRequested({ ...rest, request: restRequest })).toBeNull();
  });

  it("returns null when request is missing entirely", () => {
    const { request: _, ...noRequest } = validPayload;
    expect(parsePluginApprovalRequested(noRequest)).toBeNull();
  });

  it("returns null when id is missing", () => {
    const { id: _, ...noId } = validPayload;
    expect(parsePluginApprovalRequested(noId)).toBeNull();
  });

  it("returns null when timestamps are missing", () => {
    const { createdAtMs: _, expiresAtMs: __, ...noTimestamps } = validPayload;
    expect(parsePluginApprovalRequested(noTimestamps)).toBeNull();
  });

  it("returns null for null payload", () => {
    expect(parsePluginApprovalRequested(null)).toBeNull();
  });

  it("returns null for non-object payload", () => {
    expect(parsePluginApprovalRequested("not an object")).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const minimal = {
      id: "plugin-2",
      createdAtMs: 500,
      expiresAtMs: 60_000,
      request: { title: "Alert" },
    };
    const result = parsePluginApprovalRequested(minimal);
    expect(result?.kind).toBe("plugin");
    expect(result?.pluginTitle).toBe("Alert");
    expect(result?.pluginDescription).toBeNull();
    expect(result?.pluginSeverity).toBeNull();
    expect(result?.pluginId).toBeNull();
    expect(result?.request.agentId).toBeNull();
    expect(result?.request.sessionKey).toBeNull();
  });
});

describe("parseExecApprovalRequested command spans", () => {
  it("preserves command text spacing for span offsets", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-spaces-1",
      request: { command: "  python -c 'print(1)'" },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(parsed?.request.command).toBe("  python -c 'print(1)'");
  });

  it("rejects whitespace-only command text", () => {
    expect(
      parseExecApprovalRequested({
        id: "approval-blank-1",
        request: { command: "   " },
        createdAtMs: 1,
        expiresAtMs: 2,
      }),
    ).toBeNull();
  });

  it("preserves valid command spans from exec approval events", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-explain-1",
      request: {
        command: "ls | grep stuff",
        commandSpans: [
          { startIndex: 0, endIndex: 2 },
          { startIndex: 5, endIndex: 9 },
          { startIndex: 10, endIndex: 15 },
          { startIndex: 16, endIndex: 20 },
          { startIndex: -1, endIndex: 2 },
          { startIndex: 8, endIndex: 8 },
        ],
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(parsed?.request.commandSpans).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 10, endIndex: 15 },
    ]);
  });
});
