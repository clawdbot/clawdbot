// Codex tests cover elicitation bridge plugin behavior.
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

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mockCall(mock, index)?.at(argIndex);
}

function gatewayToolCall(index = 0) {
  return mockCall(mockCallGatewayTool, index);
}

function gatewayToolArg(index = 0, argIndex = 0) {
  return mockCallArg(mockCallGatewayTool, index, argIndex);
}

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

function buildComputerUseApprovalElicitation(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "computer-use",
    mode: "form",
    message: "Allow Codex to use Notes?",
    _meta: {
      persist: ["always"],
    },
    requestedSchema: {
      type: "object",
      properties: {},
    },
    ...overrides,
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

function buildConnectorPluginApprovalElicitation(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "codex_apps",
    mode: "form",
    message: "Allow Google Calendar to create an event?",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      source: "connector",
      connector_id: "connector_google_calendar",
      connector_name: "Google Calendar",
      tool_title: "create_event",
    },
    requestedSchema: {
      type: "object",
      properties: {},
    },
    ...overrides,
  };
}

function createPluginAppPolicyContext(
  params: {
    allowDestructiveActions?: boolean;
    destructiveApprovalMode?: "allow" | "deny" | "auto" | "ask";
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
          ...(params.destructiveApprovalMode
            ? { destructiveApprovalMode: params.destructiveApprovalMode }
            : {}),
          mcpServerNames: app.mcpServerNames,
        },
      ]),
    ),
    pluginAppIds: Object.fromEntries(
      apps.map((app) => [app.pluginName, appsForPlugin(apps, app.pluginName)]),
    ),
  };
}

function createAccountAppPolicyContext(params: {
  appId: string;
  appName: string;
  allowDestructiveActions: boolean;
  destructiveApprovalMode?: "allow" | "deny" | "auto" | "ask";
}) {
  return {
    fingerprint: "account-app-policy-1",
    apps: {
      [params.appId]: {
        source: "account" as const,
        appName: params.appName,
        allowDestructiveActions: params.allowDestructiveActions,
        ...(params.destructiveApprovalMode
          ? { destructiveApprovalMode: params.destructiveApprovalMode }
          : {}),
        mcpServerNames: [],
      },
    },
    pluginAppIds: {},
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
    const approvalRequestCall = gatewayToolCall();
    expect(approvalRequestCall?.[0]).toBe("plugin.approval.request");
    expect(approvalRequestCall?.[1]).toStrictEqual({ timeoutMs: 130_000 });
    expect(approvalRequestCall?.[3]).toStrictEqual({ expectFinal: false });
    const approvalRequest = gatewayToolArg(0, 2) as {
      description: string;
    };
    expect(approvalRequest.description).toContain("App: GitHub");
    expect(approvalRequest.description).toContain("Tool: Create pull request");
    expect(approvalRequest.description).toContain("Repository: openclaw/openclaw");
  });

  it("routes Computer Use app approvals through plugin approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
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

  it("maps Computer Use allow-always decisions onto persistent metadata", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use-always", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-computer-use-always",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: {
        persist: "always",
      },
    });
  });

  it("does not handle non-Computer Use elicitations without approval metadata", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({ serverName: "desktop-control" }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("routes configured custom Computer Use server names through plugin approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-custom-computer-use", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-custom-computer-use",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({ serverName: "desktop-control" }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "desktop-control",
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    const approvalRequest = gatewayToolArg(0, 2) as { description: string };
    expect(approvalRequest.description).toContain("MCP server: desktop-control");
  });

  it("declines approved Computer Use app approvals with unmappable non-empty schemas", async () => {
    const warnSpy = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use-fields", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use-fields", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({
        requestedSchema: {
          type: "object",
          properties: {
            appName: {
              type: "string",
              title: "App name",
            },
          },
          required: ["appName"],
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      "codex MCP approval elicitation approved without a mappable response",
      expect.objectContaining({
        fields: ["appName"],
        outcome: "approved-once",
      }),
    );
  });

  it("normalizes missing Computer Use schemas to the empty object schema", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use-schema", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-computer-use-schema",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({
        requestedSchema: "not-a-schema",
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
  });

  it("does not bridge Computer Use elicitations outside form mode", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({
        mode: "notification",
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("falls back to a Computer Use approval title and sanitizes server names", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use-title", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-computer-use-title", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({
        message: "\u001b[31m",
        serverName: "computer-use\u009b31m",
        _meta: null,
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use\u009b31m",
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    const approvalRequest = gatewayToolArg(0, 2) as {
      title: string;
      description: string;
    };
    expect(approvalRequest.title).toBe("Computer Use approval");
    expect(approvalRequest.description).toContain("MCP server: computer-use");
    expect(approvalRequest.description).not.toContain("\u009b");
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

    const approvalRequest = gatewayToolArg(0, 2) as {
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

    const approvalRequest = gatewayToolArg(0, 2) as {
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

    const approvalRequest = gatewayToolArg(0, 2) as {
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

    const approvalRequest = gatewayToolArg(0, 2) as {
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

    const approvalRequest = gatewayToolArg(0, 2) as {
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

  it("accepts connector-id plugin app elicitations when destructive actions are enabled", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("routes approvals for account-connected apps through the configured policy", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-meetings", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-meetings", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        message: "Allow ChatGPT Meetings to import a meeting?",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "chatgpt_meetings",
          connector_name: "ChatGPT Meetings",
          tool_title: "import_meeting",
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createAccountAppPolicyContext({
        appId: "chatgpt_meetings",
        appName: "ChatGPT Meetings",
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      }),
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expect(gatewayToolArg(0, 2)).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
      title: "Allow ChatGPT Meetings to import a meeting?",
      twoPhase: true,
    });
  });

  it("does not trust account app ids from non-connector MCP servers", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({
        _meta: { app_id: "chatgpt_meetings" },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createAccountAppPolicyContext({
        appId: "chatgpt_meetings",
        appName: "ChatGPT Meetings",
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  for (const { name, requestedSchema } of [
    {
      name: "declines connector-id plugin app elicitations with non-object schemas",
      requestedSchema: { type: "string", properties: {} },
    },
    {
      name: "declines connector-id plugin app elicitations without object properties",
      requestedSchema: { type: "object" },
    },
  ]) {
    it(name, async () => {
      const result = await handleCodexAppServerElicitationRequest({
        requestParams: buildConnectorPluginApprovalElicitation({ requestedSchema }),
        paramsForRun: createParams(),
        threadId: "thread-1",
        turnId: "turn-1",
        pluginAppPolicyContext: createPluginAppPolicyContext({
          allowDestructiveActions: true,
          apps: [
            {
              appId: "connector_google_calendar",
              pluginName: "google-calendar",
              mcpServerNames: [],
            },
          ],
        }),
      });

      expect(result).toEqual({ action: "decline", content: null, _meta: null });
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });
  }

  it("routes auto connector-id plugin app elicitations through plugin approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-calendar", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-calendar", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
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
    expect(gatewayToolArg(0, 2)).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
      title: "Allow Google Calendar to create an event?",
      toolName: "codex_mcp_tool_approval",
      twoPhase: true,
    });
  });

  it("maps auto plugin allow-always only when Codex offers always persistence", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-calendar-always", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-calendar-always",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "connector_google_calendar",
          connector_name: "Google Calendar",
          persist: ["session", "always"],
          tool_title: "create_event",
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: {
        persist: "always",
      },
    });
    expect(gatewayToolArg(0, 2)).toMatchObject({
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
  });

  it("does not expose allow-always for auto plugin session-only persistence", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-calendar-session", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-calendar-session",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "connector_google_calendar",
          connector_name: "Google Calendar",
          persist: ["session"],
          tool_title: "create_event",
        },
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve this app action",
            },
            persist: {
              type: "string",
              title: "Persist choice",
              enum: ["session", "always"],
            },
          },
          required: ["approve"],
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        approve: true,
      },
      _meta: null,
    });
    expect(gatewayToolArg(0, 2)).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("does not expose allow-always for ask plugin policy", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-calendar-always-policy", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-calendar-always-policy",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "connector_google_calendar",
          connector_name: "Google Calendar",
          persist: ["session", "always"],
          tool_title: "create_event",
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "ask",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    expect(gatewayToolArg(0, 2)).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("maps unexpected allow-always decisions to one-shot for ask plugin policy", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "plugin:approval-calendar-unexpected-always",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        id: "plugin:approval-calendar-unexpected-always",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "connector_google_calendar",
          connector_name: "Google Calendar",
          persist: ["session", "always"],
          tool_title: "create_event",
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "ask",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
  });

  it("declines denied auto plugin app approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-calendar-deny", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-calendar-deny", decision: "deny" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
  });

  it("fails closed when auto plugin approval routing is unavailable", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-calendar-unavailable",
      decision: null,
    });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it("cancels auto plugin app approvals when the turn aborts", async () => {
    const abortController = new AbortController();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-calendar-abort", status: "accepted" })
      .mockImplementationOnce(() => {
        abortController.abort(new Error("turn stopped"));
        return new Promise(() => {});
      });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
      signal: abortController.signal,
    });

    expect(result).toEqual({ action: "cancel", content: null, _meta: null });
  });

  it("declines connector-id plugin app elicitations when destructive actions are disabled", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: false,
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines live connector elicitations that only match display names", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_name: "Google Calendar",
          tool_title: "create_event",
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines live connector elicitations with mismatched app and connector ids", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          app_id: "other-app",
          connector_id: "connector_google_calendar",
          connector_name: "Google Calendar",
          tool_title: "create_event",
        },
      }),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        apps: [
          {
            appId: "connector_google_calendar",
            pluginName: "google-calendar",
            mcpServerNames: [],
          },
        ],
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
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
    const approvalRequestCall = gatewayToolCall();
    expect(approvalRequestCall?.[0]).toBe("plugin.approval.request");
    expect(approvalRequestCall?.[1]).toStrictEqual({ timeoutMs: 130_000 });
    expect(approvalRequestCall?.[3]).toStrictEqual({ expectFinal: false });
    const approvalRequest = gatewayToolArg(0, 2) as {
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
    const [warningMessage, warningDetails] = mockCall(warn) ?? [];
    expect(warningMessage).toBe(
      "codex MCP approval elicitation approved without a mappable response",
    );
    expect(warningDetails).toStrictEqual({
      approvalKind: "mcp_tool_call",
      fields: ["confirmChoice"],
      outcome: "approved-once",
    });
  });

  it("does not split surrogate pairs when truncating display parameter values", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-utf16-safe", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-utf16-safe", decision: "allow-once" });

    // 116 "b" + "😀" + "tail" = 122 chars. The emoji at UTF-16 positions 116-117 crosses
    // the 120-char truncateDisplayText() boundary (120 - 3 = 117). Old raw slice(0, 117)
    // would keep the lone high surrogate; truncateUtf16Safe backs off to 116.
    const displayValue = `${"b".repeat(116)}😀tail`;

    await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildApprovalElicitation(),
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_params_display: [{ name: "key", display_name: "Value", value: displayValue }],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const approvalCallParams = gatewayToolArg(0, 2) as { title?: string; description?: string };
    const description = approvalCallParams.description ?? "";
    expect(description).toContain(`${"b".repeat(116)}...`);
  });

  it("does not expose a split surrogate pair from the display scan cap", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-utf16-scan", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-utf16-scan", decision: "allow-once" });

    await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildApprovalElicitation(),
        message: `${"\u0000".repeat(4095)}😀tail`,
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const approvalCallParams = gatewayToolArg(0, 2) as { title?: string; description?: string };
    expect(approvalCallParams.title).toBe("Codex MCP tool approval");
    expect(approvalCallParams.description).not.toContain(String.fromCharCode(0xd83d));
    expect(() => encodeURIComponent(approvalCallParams.description ?? "")).not.toThrow();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
