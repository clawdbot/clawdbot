import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveToolInventoryResult } from "../../agents/tools-effective-inventory.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function makeInventoryEntry(params: {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin" | "channel";
  pluginId?: string;
  channelId?: string;
}) {
  return {
    ...params,
    rawDescription: params.description,
  };
}

function makeDefaultInventory(): EffectiveToolInventoryResult {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          makeInventoryEntry({
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            source: "core",
          }),
        ],
      },
      {
        id: "plugin",
        label: "Connected tools",
        source: "plugin",
        tools: [
          makeInventoryEntry({
            id: "docs_lookup",
            label: "Docs Lookup",
            description: "Search internal documentation",
            source: "plugin",
            pluginId: "docs",
          }),
        ],
      },
    ],
  };
}

const toolsTestState = vi.hoisted(() => {
  const defaultResolveTools = (): EffectiveToolInventoryResult => makeDefaultInventory();

  return {
    resolveToolsImpl: defaultResolveTools,
    resolveToolsMock: vi.fn((..._args: unknown[]) => defaultResolveTools()),
    threadingContext: {
      currentChannelId: "channel-123",
      currentMessageId: "message-456",
    },
    replyToMode: "all" as const,
  };
});

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: vi.fn(() => "main"),
  };
});

vi.mock("../../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: (...args: unknown[]) => toolsTestState.resolveToolsMock(...args),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildThreadingToolContext: () => toolsTestState.threadingContext,
}));

vi.mock("./reply-threading.js", () => ({
  resolveReplyToMode: () => toolsTestState.replyToMode,
}));

let buildCommandTestParams: typeof import("./commands.test-harness.js").buildCommandTestParams;
let handleToolsCommand: typeof import("./commands-info.js").handleToolsCommand;

async function loadToolsHarness(options?: { resolveTools?: () => EffectiveToolInventoryResult }) {
  toolsTestState.resolveToolsImpl = options?.resolveTools ?? (() => makeDefaultInventory());
  toolsTestState.resolveToolsMock.mockImplementation((..._args: unknown[]) =>
    toolsTestState.resolveToolsImpl(),
  );

  return {
    buildCommandTestParams,
    handleToolsCommand,
    resolveToolsMock: toolsTestState.resolveToolsMock,
  };
}

function buildConfig() {
  return {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
}

function resolveToolsArg(resolveToolsMock: { mock: { calls: unknown[][] } }, index = 0) {
  const [arg] = resolveToolsMock.mock.calls[index] ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected resolve tools call ${index + 1}`);
  }
  return arg as Record<string, unknown>;
}

describe("handleToolsCommand", () => {
  beforeAll(async () => {
    ({ buildCommandTestParams } = await import("./commands.test-harness.js"));
    ({ handleToolsCommand } = await import("./commands-info.js"));
  });

  beforeEach(() => {
    toolsTestState.resolveToolsMock.mockReset();
    toolsTestState.resolveToolsImpl = () => makeDefaultInventory();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("renders a product-facing tool list", async () => {
    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.agentId = "main";
    params.provider = "openai";
    params.model = "gpt-4.1";
    params.ctx = {
      ...params.ctx,
      From: "telegram:group:abc123",
      GroupChannel: "#ops",
      GroupSpace: "workspace-1",
      SenderName: "User Name",
      SenderUsername: "user_name",
      SenderE164: "+1000",
      MessageThreadId: 99,
      AccountId: "acct-1",
      Provider: "telegram",
      ChatType: "group",
    };

    const result = await handleToolsCommand(params, true);

    expect(result?.reply?.text).toContain("Available tools");
    expect(result?.reply?.text).toContain("Profile: coding");
    expect(result?.reply?.text).toContain("Built-in tools");
    expect(result?.reply?.text).toContain("exec");
    expect(result?.reply?.text).toContain("Connected tools");
    expect(result?.reply?.text).toContain("docs_lookup (docs)");
    expect(result?.reply?.text).not.toContain("unavailable right now");
    const toolsArg = resolveToolsArg(resolveToolsMock);
    expect(toolsArg.senderIsOwner).toBe(false);
    expect(toolsArg.senderId).toBeUndefined();
    expect(toolsArg.senderName).toBe("User Name");
    expect(toolsArg.senderUsername).toBe("user_name");
    expect(toolsArg.senderE164).toBe("+1000");
    expect(toolsArg.accountId).toBe("acct-1");
    expect(toolsArg.currentChannelId).toBe("channel-123");
    expect(toolsArg.currentThreadTs).toBe("99");
    expect(toolsArg.currentMessageId).toBe("message-456");
    expect(toolsArg.groupId).toBe("abc123");
    expect(toolsArg.groupChannel).toBe("#ops");
    expect(toolsArg.groupSpace).toBe("workspace-1");
    expect(toolsArg.replyToMode).toBe("all");
  });

  it("returns usage when arguments are provided", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const result = await handleToolsCommand(
      buildCommandTestParams("/tools extra", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /tools [compact|verbose]" },
    });
  });

  it("does not synthesize group ids for direct-chat sender ids", async () => {
    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.ctx = {
      ...params.ctx,
      From: "telegram:8231046597",
      Provider: "telegram",
      ChatType: "dm",
    };

    await handleToolsCommand(params, true);

    expect(resolveToolsArg(resolveToolsMock).groupId).toBeUndefined();
  });

  it("prefers the target session entry for tool inventory group metadata", async () => {
    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      groupId: "wrapper-group",
      groupChannel: "#wrapper",
      space: "wrapper-space",
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        groupId: "target-group",
        groupChannel: "#target",
        space: "target-space",
      },
    };
    params.ctx = {
      ...params.ctx,
      From: "telegram:group:abc123",
      Provider: "telegram",
      Surface: "telegram",
      GroupChannel: "#ctx",
      GroupSpace: "ctx-space",
    };

    await handleToolsCommand(params, true);

    const toolsArg = resolveToolsArg(resolveToolsMock);
    expect(toolsArg.groupId).toBe("target-group");
    expect(toolsArg.groupChannel).toBe("#target");
    expect(toolsArg.groupSpace).toBe("target-space");
  });

  it("renders the detailed tool list in verbose mode", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const result = await handleToolsCommand(
      buildCommandTestParams("/tools verbose", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result?.reply?.text).toContain("What this agent can use right now:");
    expect(result?.reply?.text).toContain("Profile: coding");
    expect(result?.reply?.text).toContain("Exec - Run shell commands");
    expect(result?.reply?.text).toContain("Docs Lookup - Search internal documentation");
  });

  it("accepts explicit compact mode", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const result = await handleToolsCommand(
      buildCommandTestParams("/tools compact", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result?.reply?.text).toContain("exec");
    expect(result?.reply?.text).toContain("Use /tools verbose for descriptions.");
  });

  it("ignores unauthorized senders", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.command = {
      ...params.command,
      isAuthorizedSender: false,
      senderId: "unauthorized",
    };

    const result = await handleToolsCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
  });

  it("uses the configured default account when /tools omits AccountId", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "telegram",
              label: "Telegram",
              config: {
                listAccountIds: () => ["default", "work"],
                defaultAccountId: () => "work",
                resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "work" }),
              },
            }),
          },
        },
      ]),
    );

    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams(
      "/tools",
      {
        commands: { text: true },
        channels: { telegram: { defaultAccount: "work" } },
      } as OpenClawConfig,
      undefined,
      { workspaceDir: "/tmp" },
    );
    params.agentId = "main";
    params.provider = "openai";
    params.model = "gpt-4.1";
    params.ctx = {
      ...params.ctx,
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      AccountId: undefined,
    };
    params.command = {
      ...params.command,
      channel: "telegram",
    };

    await handleToolsCommand(params, true);

    expect(resolveToolsArg(resolveToolsMock).accountId).toBe("work");
  });

  it("returns a concise fallback error on effective inventory failures", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness({
      resolveTools: () => {
        throw new Error("boom");
      },
    });

    const result = await handleToolsCommand(
      buildCommandTestParams("/tools", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Couldn't load available tools right now. Try again in a moment." },
    });
  });

  it("uses the canonical target session agent for /tools inventory", async () => {
    const { resolveSessionAgentId } = await import("../../agents/agent-scope.js");
    vi.mocked(resolveSessionAgentId).mockReturnValue("target");
    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.agentId = "main";
    params.sessionKey = "agent:target:whatsapp:direct:12345";

    const result = await handleToolsCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    const toolsArg = resolveToolsArg(resolveToolsMock);
    expect(toolsArg.agentId).toBe("target");
    expect(toolsArg.sessionKey).toBe("agent:target:whatsapp:direct:12345");
  });

  it("does not forward a stale ambient agentDir for session-bound /tools", async () => {
    const { resolveSessionAgentId } = await import("../../agents/agent-scope.js");
    vi.mocked(resolveSessionAgentId).mockReturnValue("target");
    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.agentId = "main";
    params.agentDir = "/tmp/agents/main/agent";
    params.sessionKey = "agent:target:whatsapp:direct:12345";

    const result = await handleToolsCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    const toolsArg = resolveToolsArg(resolveToolsMock);
    expect(toolsArg.agentId).toBe("target");
    expect(toolsArg.agentDir).toBeUndefined();
    expect(toolsArg.sessionKey).toBe("agent:target:whatsapp:direct:12345");
  });
});
