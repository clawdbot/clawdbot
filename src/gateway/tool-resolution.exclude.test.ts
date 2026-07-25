/**
 * Gateway tool-resolution exclusion tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type CreateOpenClawToolsArg = {
  clientCaps?: string[];
  cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  pluginToolDenylist?: string[];
  sandboxed?: boolean;
  requesterAgentIdOverride?: string;
};

type CreateOpenClawCodingToolsArg = {
  runtimeToolAllowlist?: string[];
  sessionKey?: string;
  runSessionKey?: string;
  workspaceDir?: string;
  cwd?: string;
  wrapBeforeToolCallHook?: boolean;
  scheduledToolPolicy?: {
    version: 1;
    mode: "account";
    ownerSessionKey: string;
    ownerAccountId: string;
  };
};

type LazyExecToolDefaults = {
  host?: string;
  allowBackground?: boolean;
  node?: string;
  elevated?: {
    enabled: boolean;
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
    fullAccessAvailable?: boolean;
    fullAccessBlockedReason?: string;
  };
};

type LazyExecToolPresentation = {
  description?: string;
  parameters?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => {
  function makeTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  }
  const createLazyExecToolMock = vi.fn(
    (_defaults: LazyExecToolDefaults, presentation?: LazyExecToolPresentation) => ({
      ...makeTool("exec"),
      description: presentation?.description ?? "exec tool",
      parameters: presentation?.parameters ?? { type: "object", properties: {} },
    }),
  );
  return {
    makeTool,
    createLazyExecToolMock,
    getLoadedChannelPluginMock: vi.fn(),
    createOpenClawCodingToolsMock: vi.fn(
      (_args: CreateOpenClawCodingToolsArg): ReturnType<typeof makeTool>[] => [],
    ),
    createOpenClawToolsMock: vi.fn((_args: CreateOpenClawToolsArg) => [
      makeTool("read"),
      makeTool("sessions_spawn"),
      makeTool("cron"),
      makeTool("gateway"),
      makeTool("nodes"),
    ]),
  };
});

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (args: CreateOpenClawToolsArg) => hoisted.createOpenClawToolsMock(args),
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: (args: CreateOpenClawCodingToolsArg) =>
    hoisted.createOpenClawCodingToolsMock(args),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (channel: string) => hoisted.getLoadedChannelPluginMock(channel),
}));

vi.mock("../agents/lazy-exec-tool.js", () => ({
  createLazyExecTool: (defaults: LazyExecToolDefaults, presentation?: LazyExecToolPresentation) =>
    hoisted.createLazyExecToolMock(defaults, presentation),
  resolveExecToolConfig: vi.fn(() => ({})),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools excludeToolNames", () => {
  beforeEach(() => {
    hoisted.createOpenClawToolsMock.mockClear();
    hoisted.createLazyExecToolMock.mockClear();
    hoisted.createOpenClawCodingToolsMock.mockReset();
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([]);
    hoisted.getLoadedChannelPluginMock.mockReset();
  });

  function readCreateToolsArgs(index = 0): CreateOpenClawToolsArg {
    const args = hoisted.createOpenClawToolsMock.mock.calls[index]?.[0];
    if (!args || typeof args !== "object") {
      throw new Error("expected createOpenClawTools args");
    }
    return args;
  }

  it("passes gateway client capabilities into tool construction", () => {
    resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      clientCaps: ["tool-events", "inline-widgets"],
    });

    expect(readCreateToolsArgs().clientCaps).toEqual(["tool-events", "inline-widgets"]);
  });

  it("filters loopback dedup exclusions without inheriting policy denies", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      excludeToolNames: ["read", "apply_patch"],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual([]);
    expect(args.inheritedToolDenylist).toEqual([]);
  });

  it("constructs exact coding tools for a server-minted mediated grant", () => {
    hoisted.createOpenClawCodingToolsMock.mockReturnValueOnce([hoisted.makeTool("write")]);

    const result = resolveGatewayScopedTools({
      cfg: { tools: { exec: { host: "node" } } } as OpenClawConfig,
      sessionKey: "agent:main:cron:run-1",
      runtimePolicySessionKey: "agent:main:qa-channel:group:ops",
      runId: "run-1",
      workspaceDir: "/workspace",
      cwd: "/workspace/task",
      surface: "loopback",
      excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
      mediatedToolNames: ["write"],
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:qa-channel:group:ops",
        ownerAccountId: "default",
      },
    });

    expect(result.tools.map((tool) => tool.name)).toContain("write");
    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeToolAllowlist: ["write"],
        sessionKey: "agent:main:qa-channel:group:ops",
        runSessionKey: "agent:main:cron:run-1",
        workspaceDir: "/workspace",
        cwd: "/workspace/task",
        wrapBeforeToolCallHook: false,
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:qa-channel:group:ops",
          ownerAccountId: "default",
        },
      }),
    );
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("does not fall back when policy removes a mediated coding tool", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("write"),
      hoisted.makeTool("cron"),
    ]);

    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:run-1",
      surface: "loopback",
      mediatedToolNames: ["write"],
      excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["cron"]);
  });

  it("keeps owner-only core tools visible only for owner loopback callers", () => {
    const ownerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
    });
    const nonOwnerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: false,
    });

    expect(ownerResult.tools.map((tool) => tool.name)).toEqual([
      "read",
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    expect(nonOwnerResult.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs(1);
    expect(args.pluginToolDenylist).toEqual([
      "cron",
      "gateway",
      "sessions",
      "screen",
      "terminal",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "nodes",
      "computer",
      "mobile_ui",
      "openclaw",
    ]);
    expect(args.inheritedToolDenylist).toEqual([
      "cron",
      "gateway",
      "sessions",
      "screen",
      "terminal",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "nodes",
      "computer",
      "mobile_ui",
      "openclaw",
    ]);
  });

  it("keeps real gateway deny policy inheritable while excluding native dedup tools", () => {
    resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { deny: ["exec"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      excludeToolNames: ["read", "apply_patch"],
    });

    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual(["exec"]);
    expect(args.inheritedToolDenylist).toEqual(["exec"]);
  });

  it("adds a synchronous node-forced exec tool to allowed owner loopback scopes", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "ask",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });

    expect(result.tools.map((tool) => tool.name).filter((name) => name === "exec")).toEqual([
      "exec",
    ]);
    expect(hoisted.createLazyExecToolMock).toHaveBeenCalledOnce();
    expect(hoisted.createLazyExecToolMock.mock.calls[0]?.[0]).toMatchObject({
      host: "node",
      allowBackground: false,
      elevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "ask",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });
    const presentation = hoisted.createLazyExecToolMock.mock.calls[0]?.[1];
    expect(presentation?.description).toContain("node-only");
    const schemaProperties = presentation?.parameters?.properties;
    expect(
      Object.keys(schemaProperties && typeof schemaProperties === "object" ? schemaProperties : {}),
    ).toEqual(["command", "workdir", "env", "timeout", "host", "node"]);
    const hostSchema = (
      schemaProperties && typeof schemaProperties === "object"
        ? (schemaProperties as Record<string, unknown>).host
        : undefined
    ) as { enum?: unknown } | undefined;
    expect(hostSchema?.enum).toEqual(["node"]);
  });

  it("omits all exec variants when host policy forbids node execution", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const gatewayOnly = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      execSession: { execHost: "gateway" },
    });
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const turnOverrideGateway = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      execSession: { execHost: "node" },
      execOverrides: { host: "gateway" },
    });
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const sandboxAuto = resolveGatewayScopedTools({
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(gatewayOnly.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(turnOverrideGateway.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(sandboxAuto.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("uses the runtime policy key for non-main sandbox classification", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:discord:default:direct:peer-42",
      agentId: "main",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("uses the explicit agent identity when a session key is an alias", () => {
    const cfg = {
      agents: {
        list: [{ id: "worker", tools: { deny: ["exec"] } }],
      },
    } as OpenClawConfig;
    const defaultAgent = resolveGatewayScopedTools({
      cfg,
      sessionKey: "main",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });
    const worker = resolveGatewayScopedTools({
      cfg,
      sessionKey: "main",
      agentId: "worker",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(defaultAgent.tools.map((tool) => tool.name)).toContain("exec");
    expect(worker.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs(1)).toMatchObject({ requesterAgentIdOverride: "worker" });
  });

  it("does not honor the internal node-exec flag on HTTP surfaces", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("exec"),
      hoisted.makeTool("nodes"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "http",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(hoisted.createLazyExecToolMock).not.toHaveBeenCalled();
  });

  it("filters node exec through the existing gateway deny policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: { gateway: { tools: { deny: ["exec"] } } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
  });

  it("applies the node-originated message provider policy before gateway policy", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("canvas"),
      hoisted.makeTool("web_search"),
      hoisted.makeTool("exec"),
    ]);
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:node:request:test",
      surface: "loopback",
      senderIsOwner: true,
      messageProvider: "node",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["canvas", "web_search"]);
    expect(hoisted.createLazyExecToolMock).toHaveBeenCalledOnce();
  });

  it("filters node exec through immutable sender-scoped policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "id:blocked-sender": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "discord",
      channelContext: { sender: { id: "blocked-sender" } },
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("uses persisted delegated policy instead of the sender wildcard", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-delegated-policy-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:subagent:gateway-child";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "gateway-child-session",
      updatedAt: Date.now(),
      spawnedBy: "agent:main:discord:direct:alice",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
    } as SessionEntry);

    try {
      const result = resolveGatewayScopedTools({
        cfg: {
          session: { store: storePath },
          tools: {
            toolsBySender: {
              "*": { deny: ["group:runtime", "group:fs"] },
              "id:alice": {},
            },
          },
        } as OpenClawConfig,
        sessionKey,
        surface: "loopback",
        senderIsOwner: false,
        messageProvider: "discord",
        includeNodeExecTool: true,
      });

      expect(result.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["read", "exec"]),
      );
      expect(readCreateToolsArgs().pluginToolDenylist).not.toEqual(
        expect.arrayContaining(["read", "exec"]),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("filters node exec through plugin group policy bound to group labels", () => {
    const resolveToolPolicy = vi.fn(
      (params: { groupChannel?: string | null; groupSpace?: string | null }) =>
        params.groupChannel === "ops" && params.groupSpace === "guild-blocked"
          ? { deny: ["exec"] }
          : undefined,
    );
    hoisted.getLoadedChannelPluginMock.mockReturnValue({
      groups: { resolveToolPolicy },
    });

    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:child",
      spawnedBy: "agent:main:discord:channel:bound",
      groupId: "bound",
      groupChannel: "ops",
      groupSpace: "guild-blocked",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "discord",
      includeNodeExecTool: true,
    });

    expect(resolveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "bound",
        groupChannel: "ops",
        groupSpace: "guild-blocked",
      }),
    );
    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it.each([
    { policyKey: "name:Guest Name", field: "senderName", value: "Guest Name" },
    { policyKey: "username:guest-user", field: "senderUsername", value: "guest-user" },
    { policyKey: "e164:+15550001111", field: "senderE164", value: "+15550001111" },
  ] as const)("filters node exec through $field sender policy", ({ policyKey, field, value }) => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            [policyKey]: { deny: ["exec"] },
            "*": {},
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:discord:channel:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "discord",
      includeNodeExecTool: true,
      [field]: value,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it.each([
    { label: "a non-owner external sender", messageProvider: "discord", senderIsOwner: false },
    { label: "an owner on an external channel", messageProvider: "discord", senderIsOwner: true },
  ])(
    "filters node exec through wildcard sender policy for $label",
    ({ messageProvider, senderIsOwner }) => {
      const result = resolveGatewayScopedTools({
        cfg: {
          tools: {
            toolsBySender: {
              "*": { deny: ["exec"] },
            },
          },
        } as OpenClawConfig,
        sessionKey: "agent:main:discord:channel:dev",
        surface: "loopback",
        senderIsOwner,
        messageProvider,
        includeNodeExecTool: true,
      });

      expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
      expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
    },
  );

  it("preserves owner WebChat access from wildcard sender policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        tools: {
          toolsBySender: {
            "*": { deny: ["exec"] },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
      senderIsOwner: true,
      messageProvider: "webchat",
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).not.toContain("exec");
  });

  it("filters node exec through global provider policy", () => {
    const cfg = {
      tools: {
        byProvider: {
          anthropic: { deny: ["exec"] },
        },
      },
    } as OpenClawConfig;
    const blocked = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    const allowed = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "openai",
      modelId: "gpt-5.5",
    });

    expect(blocked.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(allowed.tools.map((tool) => tool.name)).toContain("exec");
  });

  it("filters node exec through agent model policy", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              byProvider: {
                "anthropic/claude-opus-4-7": { deny: ["exec"] },
              },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const blocked = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    const allowed = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(blocked.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(allowed.tools.map((tool) => tool.name)).toContain("exec");
  });

  it("filters node exec through group sender-scoped policy", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        channels: {
          telegram: {
            groups: {
              dev: {
                toolsBySender: {
                  "id:blocked-sender": { deny: ["exec"] },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:dev",
      surface: "loopback",
      senderIsOwner: false,
      messageProvider: "telegram",
      channelContext: { sender: { id: "blocked-sender" } },
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).not.toContain("exec");
    expect(readCreateToolsArgs().pluginToolDenylist).toContain("exec");
  });

  it("does not inherit node-only exec as a generic child or cron capability", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { allow: ["exec", "sessions_spawn", "cron"] } } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
      includeNodeExecTool: true,
    });

    expect(result.tools.map((tool) => tool.name)).toContain("exec");
    expect(readCreateToolsArgs().inheritedToolAllowlist).not.toContain("exec");
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).not.toContainEqual({ name: "exec" });
  });

  it("passes sandbox context and inherited sandbox denies into loopback tools", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { sandbox: { tools: { deny: ["cron"] } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs();
    expect(args.sandboxed).toBe(true);
    expect(args.pluginToolDenylist).toEqual(["cron"]);
    expect(args.inheritedToolDenylist).toEqual(["cron"]);
  });

  it("passes final filtered tool surface to gateway cron jobs", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("cron"),
      hoisted.makeTool("exec"),
    ]);

    const result = resolveGatewayScopedTools({
      cfg: {
        tools: { allow: ["read", "cron"] },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "cron"]);
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).toEqual([
      { name: "read" },
      { name: "cron" },
    ]);
  });

  it("passes unrestricted gateway tool surfaces to cron jobs", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("cron"),
      hoisted.makeTool("exec"),
    ]);

    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "cron", "exec"]);
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).toEqual([
      { name: "read" },
      { name: "cron" },
      { name: "exec" },
    ]);
  });
});
