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

function buildPluginApprovalElicitation(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "google-calendar-mcp",
    mode: "form",
    message: "Approve app action?",
    _meta: {
      app_id: "google-calendar-app",
    },
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve this app action",
        },
      },
      required: ["approve"],
    },
    ...overrides,
  };
}

function createPluginAppPolicyContext(
  params: {
    allowDestructiveActions?: boolean;
    apps?: Array<{ appId: string; pluginName: string; mcpServerNames: string[] }>;
  } = {},
) {
  const apps = params.apps ?? [
    {
      appId: "google-calendar-app",
      pluginName: "google-calendar",
      mcpServerNames: ["google-calendar-mcp"],
    },
  ];
  return {
    fingerprint: "plugin-policy-1",
    apps: Object.fromEntries(
      apps.map((app) => [
        app.appId,
        {
          configKey: app.pluginName,
          marketplaceName: "openai-curated" as const,
          pluginName: app.pluginName,
          allowDestructiveActions: params.allowDestructiveActions ?? false,
          mcpServerNames: app.mcpServerNames,
        },
      ]),
    ),
    pluginAppIds: Object.fromEntries(
      apps.map((app) => [app.pluginName, appsForPlugin(apps, app.pluginName)]),
    ),
  };
}

function appsForPlugin(
  apps: Array<{ appId: string; pluginName: string; mcpServerNames: string[] }>,
  pluginName: string,
): string[] {
  return apps
    .filter((app) => app.pluginName === pluginName)
    .map((app) => app.appId)
    .toSorted();
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

  it("does not trust request-time decisions for two-phase MCP approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "plugin:approval-untrusted",
        status: "accepted",
        decision: "allow-always",
      })
      .mockResolvedValueOnce({ id: "plugin:approval-untrusted", decision: "deny" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("does not treat inherited request-time MCP decisions as final", async () => {
    const inheritedDecisionResult = Object.assign(Object.create({ decision: null }), {
      id: "plugin:approval-inherited",
      status: "accepted",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce(inheritedDecisionResult)
      .mockResolvedValueOnce({ id: "plugin:approval-inherited", decision: "allow-once" });

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
    const approvalRequestCall = mockCallGatewayTool.mock.calls[0];
    expect(approvalRequestCall?.[0]).toBe("plugin.approval.request");
    expect(approvalRequestCall?.[1]).toStrictEqual({ timeoutMs: 130_000 });
    expect(approvalRequestCall?.[3]).toStrictEqual({ expectFinal: false });
    const approvalRequest = approvalRequestCall?.[2] as {
      description: string;
    };
    expect(approvalRequest.description).toContain("App: GitHub");
    expect(approvalRequest.description).toContain("Tool: Create pull request");
    expect(approvalRequest.description).toContain("Repository: openclaw/openclaw");
  });

  it("strips control and invisible formatting from approval display text", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized", decision: "allow-once" });

    await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildCurrentCodexApprovalElicitation(),
        message: "Approve\u202e hidden",
        serverName: "codex\u009b31m_apps__github",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "GitHub\nInjected: approve",
          tool_title: "\u001b]8;;https://evil.example\u001b\\Visible tool\u001b]8;;\u001b\\",
          tool_description: "Creates\u0000 a\u202e pull request",
          tool_params_display: [
            {
              name: "repo",
              display_name: "Repository\u202e",
              value: "\u001b]8;;https://evil.example\u001b\\openclaw/openclaw\u001b]8;;\u001b\\",
            },
          ],
        },
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve\u202e this tool call",
              description: "Confirm\u009b31m access",
            },
          },
          required: ["approve"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      title: string;
      description: string;
    };
    expect(approvalRequest.title).toBe("Approve hidden");
    expect(approvalRequest.description).toContain("GitHub Injected: approve");
    expect(approvalRequest.description).toContain("Tool: Visible tool");
    expect(approvalRequest.description).toContain("Repository: openclaw/openclaw");
    expect(approvalRequest.description).toContain("- Approve this tool call: Confirm access");
    expect(approvalRequest.description).not.toContain("https://evil.example");
    expect(approvalRequest.description).not.toContain("\u001b");
    expect(approvalRequest.description).not.toContain("\u009b");
    expect(approvalRequest.description).not.toContain("\u202e");
  });

  it("escapes approval display text before forwarding approval prompts", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-escaped", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-escaped", decision: "allow-once" });

    await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildCurrentCodexApprovalElicitation(),
        message: "Approve <@U123>",
        serverName: "server @here",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "GitHub [trusted](https://evil)",
          tool_title: "Create <@U123>",
          tool_description: "Use @here",
          tool_params_display: [
            {
              name: "repo",
              display_name: "Repository [trusted](https://evil)",
              value: "<@U123>",
            },
          ],
        },
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve <@U123>",
              description: "Confirm @here",
            },
          },
          required: ["approve"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      title: string;
      description: string;
    };
    expect(approvalRequest.title).toBe("Approve &lt;\uff20U123&gt;");
    expect(approvalRequest.description).toContain(
      "GitHub \uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(approvalRequest.description).toContain("Tool: Create &lt;\uff20U123&gt;");
    expect(approvalRequest.description).toContain("MCP server: server \uff20here");
    expect(approvalRequest.description).toContain(
      "Repository \uff3btrusted\uff3d\uff08https://evil\uff09: &lt;\uff20U123&gt;",
    );
    expect(approvalRequest.description).toContain(
      "- Approve &lt;\uff20U123&gt;: Confirm \uff20here",
    );
    expect(approvalRequest.description).not.toContain("<@U123>");
    expect(approvalRequest.description).not.toContain("[trusted](https://evil)");
    expect(approvalRequest.description).not.toContain("@here");
  });

  it("falls back to stable names when display labels sanitize to empty", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-label-fallback", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-label-fallback", decision: "allow-once" });

    await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildCurrentCodexApprovalElicitation(),
        message: "Approve",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "App",
          tool_params_display: [
            {
              name: "repo",
              display_name: "\u202e",
              value: "openclaw/openclaw",
            },
          ],
        },
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "\u202e",
              description: "Confirm access",
            },
          },
          required: ["approve"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      description: string;
    };
    expect(approvalRequest.description).toContain("- repo: openclaw/openclaw");
    expect(approvalRequest.description).toContain("- approve: Confirm access");
    expect(approvalRequest.description).not.toContain("- field: Confirm access");
  });

  it("bounds deep approval display parameter values before forwarding them", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-bounded-params", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-bounded-params", decision: "allow-once" });

    await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildCurrentCodexApprovalElicitation(),
        message: "Approve",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "App",
          tool_title: "Tool",
          tool_params_display: [
            {
              name: "payload",
              value: {
                key0: { nested: { deeper: { secret: "hidden" } } },
                key1: 1,
                key2: 2,
                key3: 3,
                key4: 4,
                key5: 5,
                key6: 6,
                key7: 7,
                key8: 8,
              },
            },
          ],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      description: string;
    };
    expect(approvalRequest.description).toContain("payload");
    expect(approvalRequest.description).toContain("key0");
    expect(approvalRequest.description).not.toContain("key8");
    expect(approvalRequest.description).not.toContain("hidden");
  });

  it("caps approval display parameter entries before forwarding them", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-capped-params", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-capped-params", decision: "allow-once" });

    await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildCurrentCodexApprovalElicitation(),
        message: "Approve",
        serverName: "",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "App",
          tool_params_display: Array.from({ length: 9 }, (_, index) => ({
            name: `p${index}`,
            value: index,
          })),
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      description: string;
    };
    expect(approvalRequest.description).toContain("p0");
    expect(approvalRequest.description).toContain("p7");
    expect(approvalRequest.description).toContain("Additional parameters: 1 more");
    expect(approvalRequest.description).not.toContain("p8");
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

  it("declines plugin app elicitations when destructive actions are disabled", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: false }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("accepts safely mapped plugin app elicitations when destructive actions are enabled", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toEqual({
      action: "accept",
      content: { approve: true },
      _meta: null,
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines plugin app elicitations that are missing active turn correlation", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({ turnId: null }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("does not answer plugin app elicitations for a different active turn", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({ turnId: "turn-2" }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines plugin app elicitations with ambiguous server ownership", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({
        serverName: "shared-mcp",
        _meta: {},
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        apps: [
          {
            appId: "calendar-app-1",
            pluginName: "google-calendar",
            mcpServerNames: ["shared-mcp"],
          },
          {
            appId: "calendar-app-2",
            pluginName: "google-calendar",
            mcpServerNames: ["shared-mcp"],
          },
        ],
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines plugin app elicitations that only match display names", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({
        serverName: "unknown-mcp",
        _meta: {
          connector_name: "Google Calendar",
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines plugin-scoped elicitations when policy context is missing", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines plugin app elicitations with unmappable schemas", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({
        requestedSchema: {
          type: "object",
          properties: {
            template: {
              type: "string",
              enum: ["simple", "detailed"],
            },
          },
          required: ["template"],
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps unrelated MCP approval elicitations on the existing approval bridge", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-unrelated", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-unrelated", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildCurrentCodexApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
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
    const approvalRequestCall = mockCallGatewayTool.mock.calls[0];
    expect(approvalRequestCall?.[0]).toBe("plugin.approval.request");
    expect(approvalRequestCall?.[1]).toStrictEqual({ timeoutMs: 130_000 });
    expect(approvalRequestCall?.[3]).toStrictEqual({ expectFinal: false });
    const approvalRequest = approvalRequestCall?.[2] as {
      title: string;
      description: string;
    };
    expect(typeof approvalRequest.title).toBe("string");
    expect(typeof approvalRequest.description).toBe("string");
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
    const [warningMessage, warningDetails] = warn.mock.calls[0] ?? [];
    expect(warningMessage).toBe(
      "codex MCP approval elicitation approved without a mappable response",
    );
    expect(warningDetails).toStrictEqual({
      approvalKind: "mcp_tool_call",
      fields: ["confirmChoice"],
      outcome: "approved-once",
    });
  });
});
