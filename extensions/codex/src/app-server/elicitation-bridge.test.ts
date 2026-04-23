import {
  callGatewayTool,
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    messageChannel: "telegram",
    currentChannelId: "chat-1",
    agentAccountId: "default",
    currentThreadTs: "thread-ts",
  } as unknown as EmbeddedRunAttemptParams;
}

function buildApprovalElicitation() {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "codex_apps__github",
    mode: "form",
    message: "Approve app tool call?",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve this tool call",
        },
        persist: {
          type: "string",
          title: "Persist choice",
          enum: ["session", "always"],
        },
      },
      required: ["approve"],
    },
  };
}

function buildCurrentCodexApprovalElicitation() {
  return {
    ...buildApprovalElicitation(),
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      connector_name: "GitHub",
      tool_title: "Create pull request",
      tool_description: "Creates a pull request in the selected repository.",
      tool_params_display: [
        { name: "repo", display_name: "Repository", value: "openclaw/openclaw" },
      ],
    },
    requestedSchema: {
      type: "object",
      properties: {},
    },
  };
}

describe("Codex app-server elicitation bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    vi.restoreAllMocks();
  });

  it("routes MCP tool approval elicitations through plugin approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        approve: true,
      },
      _meta: null,
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("accepts current Codex MCP approval elicitations with an empty form schema", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-current", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-current", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildCurrentCodexApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        description: expect.stringContaining("App: GitHub"),
      }),
      { expectFinal: false },
    );
    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      description: string;
    };
    expect(approvalRequest.description).toContain("Tool: Create pull request");
    expect(approvalRequest.description).toContain("Repository: openclaw/openclaw");
  });

  it("accepts approval elicitations with a null turn id when the thread matches", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-null-turn", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-null-turn", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildCurrentCodexApprovalElicitation(),
        turnId: null,
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
  });

  it("ignores unscoped approval elicitations without the active thread id", async () => {
    const { turnId, serverName, mode, message, _meta, requestedSchema } =
      buildCurrentCodexApprovalElicitation();
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: { turnId, serverName, mode, message, _meta, requestedSchema },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("maps allow-always decisions onto persistent approval metadata when offered", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-2", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-2", decision: "allow-always" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        approve: true,
        persist: "always",
      },
      _meta: {
        persist: "always",
      },
    });
  });

  it("maps allow-always decisions onto metadata for current empty-schema approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-current-always", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-current-always", decision: "allow-always" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildCurrentCodexApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: {
        persist: "always",
      },
    });
  });

  it("does not inherit persist defaults for one-time approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-5", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-5", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildApprovalElicitation(),
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve this tool call",
            },
            persist: {
              type: "string",
              title: "Persist choice",
              enum: ["session", "always"],
              default: "always",
            },
          },
          required: ["approve"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        approve: true,
      },
      _meta: null,
    });
  });

  it("truncates long approval titles and descriptions before requesting approval", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-4", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-4", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildApprovalElicitation(),
        message: "Approve ".repeat(20).trim(),
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve this tool call",
              description: "Explain ".repeat(60).trim(),
            },
          },
          required: ["approve"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        approve: true,
      },
      _meta: null,
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        title: expect.any(String),
        description: expect.any(String),
      }),
      { expectFinal: false },
    );
    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      title: string;
      description: string;
    };
    expect(approvalRequest.title.length).toBeLessThanOrEqual(80);
    expect(approvalRequest.description.length).toBeLessThanOrEqual(256);
  });

  it("fails closed when the approval route is unavailable", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "plugin:approval-3", decision: null });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  it("ignores non-approval elicitation requests", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps__github",
        mode: "form",
        message: "Choose a template",
        _meta: {},
        requestedSchema: {
          type: "object",
          properties: {
            template: {
              type: "string",
              enum: ["simple", "fancy"],
            },
          },
          required: ["template"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("logs and declines approved elicitations that do not expose an approval field", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-6", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-6", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildApprovalElicitation(),
        requestedSchema: {
          type: "object",
          properties: {
            confirmChoice: {
              type: "string",
              title: "Confirmation choice",
              enum: ["yes", "no"],
            },
          },
          required: ["confirmChoice"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    expect(warn).toHaveBeenCalledWith(
      "codex MCP approval elicitation approved without a mappable response",
      expect.objectContaining({
        approvalKind: "mcp_tool_call",
        fields: ["confirmChoice"],
        outcome: "approved-once",
      }),
    );
  });
});
