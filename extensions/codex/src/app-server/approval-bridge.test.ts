import {
  callGatewayTool,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalResponse, handleCodexAppServerApprovalRequest } from "./approval-bridge.js";

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
    onAgentEvent: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

describe("Codex app-server approval bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("routes command approvals through plugin approvals and accepts allowed commands", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        command: "pnpm test extensions/codex/src/app-server",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        pluginId: "openclaw-codex-app-server",
        title: "Codex app-server command approval",
        twoPhase: true,
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
      }),
      { expectFinal: false },
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ status: "pending", approvalId: "plugin:approval-1" }),
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ status: "approved", approvalId: "plugin:approval-1" }),
      }),
    );
  });

  it("describes command approvals from parsed command actions when available", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-actions", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-actions", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-actions",
        command: "bash -lc 'pnpm test extensions/codex'",
        commandActions: [{ command: "pnpm test extensions/codex" }],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("Command: pnpm test extensions/codex"),
      }),
    );
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: expect.not.stringContaining("bash -lc"),
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ command: "pnpm test extensions/codex" }),
      }),
    );
  });

  it("sanitizes command previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-sanitized",
        command: ["pnpm", "test\n--watch", "\u001b[31mextensions/codex/src/app-server\u001b[0m"],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description:
          "Command: pnpm test --watch extensions/codex/src/app-server\nSession: agent:main:session-1",
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({
          status: "pending",
          command: "pnpm test --watch extensions/codex/src/app-server",
        }),
      }),
    );
  });

  it("preserves visible OSC-8 link labels in command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-osc", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-osc", decision: "allow-once" });
    const esc = "\u001b";

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-osc",
        command: `prefix ${esc}]8;;https://example.com${esc}\\VISIBLE${esc}]8;;${esc}\\ suffix`,
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: "Command: prefix VISIBLE suffix\nSession: agent:main:session-1",
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ command: "prefix VISIBLE suffix" }),
      }),
    );
  });

  it("strips bidi and invisible formatting controls from command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-bidi",
        command: "echo safe\u202e cod.exe\u2066 hidden\u2069 \ufeffdone\u{e0100}",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: "Command: echo safe cod.exe hidden done\nSession: agent:main:session-1",
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ command: "echo safe cod.exe hidden done" }),
      }),
    );
  });

  it("marks oversized unsafe command previews as omitted", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", decision: "allow-once" });
    const esc = "\u001b";
    const oversizedPrefix = `${esc}]8;;https://example.com${esc}\\`.repeat(300);

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-omitted",
        command: [oversizedPrefix, "TAIL"],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description:
          "Command: [preview truncated or unsafe content omitted]\nSession: agent:main:session-1",
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({
          commandPreviewOmitted: true,
        }),
      }),
    );
  });

  it("marks clipped command previews even when a safe prefix remains", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-clipped",
        command: `${"a".repeat(5000)} tail`,
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    const description = (requestPayload as { description: string }).description;
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({
          commandPreviewOmitted: true,
        }),
      }),
    );
  });

  it("does not trust request-time decisions for two-phase command approvals", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "plugin:approval-untrusted",
        status: "accepted",
        decision: "allow-always",
      })
      .mockResolvedValueOnce({ id: "plugin:approval-untrusted", decision: "deny" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-untrusted",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({
          status: "denied",
          approvalId: "plugin:approval-untrusted",
        }),
      }),
    );
  });

  it("only treats own null data-property request decisions as no-route", async () => {
    const params = createParams();
    const inheritedDecisionResult = Object.assign(Object.create({ decision: null }), {
      id: "plugin:approval-inherited",
      status: "accepted",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce(inheritedDecisionResult)
      .mockResolvedValueOnce({ id: "plugin:approval-inherited", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-inherited",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("does not invoke request-time decision accessors", async () => {
    const params = createParams();
    const requestResult = {
      id: "plugin:approval-accessor",
      status: "accepted",
      get decision() {
        throw new Error("decision getter must not run");
      },
    };
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-accessor", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-accessor",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("does not fail when request-time decision descriptors throw", async () => {
    const params = createParams();
    const requestResult = new Proxy(
      { id: "plugin:approval-proxy", status: "accepted" },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "decision") {
            throw new Error("descriptor trap must not fail approval");
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-proxy", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-proxy",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("fails closed when no approval route is available", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-2",
      decision: null,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-1",
        reason: "needs write access",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ status: "unavailable", reason: "needs write access" }),
      }),
    );
  });

  it("sanitizes reason previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-sanitized-reason",
      decision: null,
    });

    await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-sanitized",
        reason: "needs write access\nfor \u001b[31m/tmp\u001b[0m\tplease",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: "Reason: needs write access for /tmp please\nSession: agent:main:session-1",
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({
          status: "unavailable",
          reason: "needs write access for /tmp please",
        }),
      }),
    );
  });

  it("fails closed for unsupported native approval methods without requesting plugin approval", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "future/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "future-1",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });
  it("labels permission approvals explicitly with permission detail", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-3", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-3", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-1",
        permissions: {
          network: { allowHosts: ["example.com", "*.internal"] },
          fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      permissions: {
        network: { allowHosts: ["example.com", "*.internal"] },
        fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
      },
      scope: "turn",
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        title: "Codex app-server permission approval",
        toolName: "codex_permission_approval",
        description: expect.stringContaining("Permissions: network, fileSystem"),
      }),
      { expectFinal: false },
    );
    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    const description = (requestPayload as { description: string }).description;
    expect(description).toContain("Network allowHosts: example.com, *.internal");
    expect(description).toContain("File system roots: /; writePaths: ~");
    expect(description).toContain(
      "High-risk targets: wildcard hosts, private-network wildcards, filesystem root",
    );
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: expect.not.stringContaining("agent:main:session-1"),
      }),
    );
  });

  it("keeps permission detail bounded with truncated and compacted target samples", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-4", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-4", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-2",
        permissions: {
          network: {
            allowHosts: [
              "https://secret-token@example.com/private",
              "*.internal",
              "very-long-service-name.example.corp",
              "third.example.com",
            ],
          },
          fileSystem: {
            roots: ["/", "/workspace/project", "/Users/simone/Documents"],
            readPaths: ["/Users/simone/.ssh/id_rsa", "/etc/hosts", "/var/log/system.log"],
            writePaths: ["/tmp/output", "/var/log/app", "/home/simone/private"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: expect.any(String),
      }),
    );
    const description = (requestPayload as { description: string }).description;
    expect(description.length).toBeLessThanOrEqual(700);
    expect(description).toContain("example.com");
    expect(description).not.toContain("secret-token");
    expect(description).not.toContain("simone");
    expect(description).toContain("*.internal");
    expect(description).toContain("/workspace/project");
    expect(description).toContain("High-risk targets:");
    expect(description).toContain("readPaths: ~/.ssh/id_rsa, /etc/hosts");
  });

  it("compacts Windows home paths in permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-windows-home",
        permissions: {
          fileSystem: {
            roots: ["C:/Users/alice"],
            readPaths: ["C:\\Users\\alice\\.ssh\\id_rsa", "c:/users/bob/project"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    const description = (requestPayload as { description: string }).description;
    expect(description).toContain("File system roots: ~; readPaths: ~/.ssh/id_rsa, ~/project");
    expect(description).not.toContain("High-risk targets");
  });

  it("strips terminal and invisible controls from permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-controls",
        permissions: {
          network: { allowHosts: ["exa\u009b31mmple.com", "safe\u202e.example.com"] },
          fileSystem: { roots: ["/tmp/\u001b[31mproject\u001b[0m"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    const description = (requestPayload as { description: string }).description;
    expect(description).toContain("example.com");
    expect(description).toContain("safe .example.com");
    expect(description).toContain("/tmp/project");
    expect(description).not.toContain("\u009b");
    expect(description).not.toContain("\u202e");
    expect(description).not.toContain("\u001b");
  });

  it("ignores approval requests that are missing explicit thread or turn ids", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        itemId: "cmd-2",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });

  it("maps app-server approval response families separately", () => {
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["accept"] },
        "approved-session",
      ),
    ).toEqual({
      decision: "accept",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        {
          availableDecisions: [
            "accept",
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: {
                  permissions: [{ permission: "allow", command: ["pnpm", "test"] }],
                },
              },
            },
          ],
        },
        "approved-session",
      ),
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: {
            permissions: [{ permission: "allow", command: ["pnpm", "test"] }],
          },
        },
      },
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        {
          availableDecisions: [
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  domain: "registry.npmjs.org",
                },
              },
            },
          ],
        },
        "approved-session",
      ),
    ).toEqual({
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            domain: "registry.npmjs.org",
          },
        },
      },
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "approved-once",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "approved-session",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse("item/commandExecution/requestApproval", undefined, "approved-once"),
    ).toEqual({
      decision: "accept",
    });
    expect(
      buildApprovalResponse("item/commandExecution/requestApproval", undefined, "approved-session"),
    ).toEqual({
      decision: "acceptForSession",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["cancel"] },
        "approved-once",
      ),
    ).toEqual({
      decision: "cancel",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["accept", "cancel"] },
        "denied",
      ),
    ).toEqual({
      decision: "cancel",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "cancelled",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(buildApprovalResponse("item/fileChange/requestApproval", undefined, "denied")).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse(
        "item/permissions/requestApproval",
        {
          permissions: {
            network: { allowHosts: ["example.com"] },
            fileSystem: null,
          },
        },
        "approved-once",
      ),
    ).toEqual({
      permissions: { network: { allowHosts: ["example.com"] } },
      scope: "turn",
    });
    expect(buildApprovalResponse("future/requestApproval", undefined, "approved-once")).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
  });
});
