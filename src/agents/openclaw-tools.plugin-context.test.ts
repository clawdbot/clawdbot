import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("openclaw plugin tool context", () => {
  it("forwards trusted requester sender identity", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        requesterSenderId: "trusted-sender",
        senderIsOwner: true,
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        requesterSenderId: "trusted-sender",
        senderIsOwner: true,
      }),
    );
  });

  it("forwards fs policy for plugin tool sandbox enforcement", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        fsPolicy: { workspaceOnly: true },
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        fsPolicy: { workspaceOnly: true },
      }),
    );
  });

  it("forwards ephemeral sessionId", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentSessionKey: "agent:main:telegram:direct:12345",
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:12345",
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      }),
    );
  });

  it("infers the default agent workspace when workspaceDir is omitted", () => {
    const workspaceDir = path.join(process.cwd(), "tmp-main-workspace");
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {
          agents: {
            defaults: { workspace: workspaceDir },
            list: [{ id: "main", default: true }],
          },
        } as never,
        agentSessionKey: "main",
      },
      resolvedConfig: {
        agents: {
          defaults: { workspace: workspaceDir },
          list: [{ id: "main", default: true }],
        },
      } as never,
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        agentId: "main",
        workspaceDir,
      }),
    );
  });

  it("infers the session agent workspace when workspaceDir is omitted", () => {
    const supportWorkspace = path.join(process.cwd(), "tmp-support-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "support", workspace: supportWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "agent:support:main",
      },
      resolvedConfig: config,
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        agentId: "support",
        workspaceDir: supportWorkspace,
      }),
    );
  });

  it("uses requester agent override for synthetic embedded session keys", () => {
    const recallWorkspace = path.join(process.cwd(), "tmp-recall-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "recall", workspace: recallWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "explicit:user-session:active-memory:abc123",
        requesterAgentIdOverride: "recall",
      },
      resolvedConfig: config,
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        agentId: "recall",
        workspaceDir: recallWorkspace,
      }),
    );
  });

  it("forwards browser session wiring", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        sandboxBrowserBridgeUrl: "http://127.0.0.1:9999",
        allowHostBrowserControl: true,
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        browser: {
          sandboxBridgeUrl: "http://127.0.0.1:9999",
          allowHostControl: true,
        },
      }),
    );
  });

  it("forwards gateway subagent binding", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        allowGatewaySubagentBinding: true,
      },
    });

    expect(result.allowGatewaySubagentBinding).toBe(true);
  });

  it("forwards ambient deliveryContext", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentChannel: "slack",
        agentTo: "channel:C123",
        agentAccountId: "work",
        agentThreadId: "1710000000.000100",
      },
    });

    expect(result.context).toEqual(
      expect.objectContaining({
        deliveryContext: {
          channel: "slack",
          to: "channel:C123",
          accountId: "work",
          threadId: "1710000000.000100",
        },
      }),
    );
  });

  it("does not inject ambient thread defaults into plugin tools", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const sharedTool: AnyAgentTool = {
      name: "plugin-thread-default",
      label: "plugin-thread-default",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string" },
        },
      },
      execute: executeMock,
    };

    const [first] = applyPluginToolDeliveryDefaults({
      tools: [sharedTool],
      deliveryContext: { threadId: "111.222" },
    });
    const [second] = applyPluginToolDeliveryDefaults({
      tools: [sharedTool],
      deliveryContext: { threadId: "333.444" },
    });

    expect(first).toBe(sharedTool);
    expect(second).toBe(sharedTool);

    await first?.execute("call-1", {});
    await second?.execute("call-2", {});

    expect(executeMock).toHaveBeenNthCalledWith(1, "call-1", {});
    expect(executeMock).toHaveBeenNthCalledWith(2, "call-2", {});
  });

  it("does not inject messageThreadId defaults for missing params objects", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "plugin-message-thread-default",
      label: "plugin-message-thread-default",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          messageThreadId: { type: "number" },
        },
      },
      execute: executeMock,
    };

    const [wrapped] = applyPluginToolDeliveryDefaults({
      tools: [tool],
      deliveryContext: { threadId: "77" },
    });

    await wrapped?.execute("call-1", undefined);

    expect(executeMock).toHaveBeenCalledWith("call-1", undefined);
  });

  it("does not infer string thread ids for tools that declare thread parameters", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "plugin-string-thread-default",
      label: "plugin-string-thread-default",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string" },
        },
      },
      execute: executeMock,
    };

    const [wrapped] = applyPluginToolDeliveryDefaults({
      tools: [tool],
      deliveryContext: { threadId: "77" },
    });

    await wrapped?.execute("call-1", {});

    expect(executeMock).toHaveBeenCalledWith("call-1", {});
  });

  it("preserves explicit thread params when ambient defaults exist", async () => {
    const executeMock = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "plugin-thread-override",
      label: "plugin-thread-override",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string" },
        },
      },
      execute: executeMock,
    };

    const [wrapped] = applyPluginToolDeliveryDefaults({
      tools: [tool],
      deliveryContext: { threadId: "111.222" },
    });

    await wrapped?.execute("call-1", { threadId: "explicit" });

    expect(executeMock).toHaveBeenCalledWith("call-1", { threadId: "explicit" });
  });
});
