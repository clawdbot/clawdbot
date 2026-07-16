// Tests info-style commands that report context, status, skills, and session exports.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { handleContextCommand } from "./commands-context-command.js";
import {
  handleExportSessionCommand,
  handleExportTrajectoryCommand,
  handleSkillCommandUsage,
  handleStatusCommand,
} from "./commands-info.js";
import { buildStatusPluginsReply, buildStatusReply } from "./commands-status.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { handleWhoamiCommand } from "./commands-whoami.js";

const buildContextReplyMock = vi.hoisted(() => vi.fn());
const buildExportTrajectoryCommandReplyMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "exported" })),
);
const buildExportSessionReplyMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "session exported" })),
);
const listSkillCommandsForAgentsMock = vi.hoisted(() => vi.fn(() => []));
const buildCommandsMessagePaginatedMock = vi.hoisted(() =>
  vi.fn(() => ({ text: "/commands", currentPage: 1, totalPages: 1 })),
);

vi.mock("./commands-context-report.js", () => ({
  buildContextReply: buildContextReplyMock,
}));

vi.mock("./commands-export-trajectory.js", () => ({
  buildExportTrajectoryCommandReply: buildExportTrajectoryCommandReplyMock,
}));

vi.mock("./commands-export-session.js", () => ({
  buildExportSessionReply: buildExportSessionReplyMock,
}));

vi.mock("./commands-status.js", () => ({
  buildStatusPluginsReply: vi.fn(async () => ({ text: "plugins status reply" })),
  buildStatusReply: vi.fn(async () => ({ text: "status reply" })),
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: vi.fn(actual.resolveSessionAgentId),
  };
});

vi.mock("../../skills/discovery/chat-commands.js", async () => {
  const actual = await vi.importActual<typeof import("../../skills/discovery/chat-commands.js")>(
    "../../skills/discovery/chat-commands.js",
  );
  return {
    ...actual,
    listSkillCommandsForAgents: listSkillCommandsForAgentsMock,
  };
});

vi.mock("../status.js", async () => {
  const actual = await vi.importActual<typeof import("../status.js")>("../status.js");
  return {
    ...actual,
    buildCommandsMessagePaginated: buildCommandsMessagePaginatedMock,
  };
});

function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  expect(mock.mock.calls).toHaveLength(1);
  const [arg] = mock.mock.calls.at(0) ?? [];
  if (!arg) {
    throw new Error(`expected ${label} to receive arguments`);
  }
  return arg;
}

function buildInfoParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      ...ctxOverrides,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "12345",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "12345",
      to: "bot",
    },
    sessionKey: "agent:main:whatsapp:direct:12345",
    workspaceDir: "/tmp",
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
  } as unknown as HandleCommandsParams;
}

describe("info command handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildExportSessionReplyMock.mockResolvedValue({ text: "session exported" });
    buildExportTrajectoryCommandReplyMock.mockResolvedValue({ text: "exported" });
    buildContextReplyMock.mockImplementation(async (params: HandleCommandsParams) => {
      const normalized = params.command.commandBodyNormalized;
      if (normalized === "/context list") {
        return { text: "Injected workspace files:\n- AGENTS.md" };
      }
      if (normalized === "/context detail") {
        return { text: "Context breakdown (detailed)\nTop tools (schema size):" };
      }
      return { text: "/context\n- /context list\nInline shortcut" };
    });
    buildCommandsMessagePaginatedMock.mockReturnValue({
      text: "/commands",
      currentPage: 1,
      totalPages: 1,
    });
  });

  it.each([
    ["unauthorized sender", false, true],
    ["authorized non-owner", true, false],
  ])("blocks %s from exporting a session", async (_label, isAuthorizedSender, senderIsOwner) => {
    const params = buildInfoParams("/export-session", {
      commands: { text: true },
    } as OpenClawConfig);
    params.command.isAuthorizedSender = isAuthorizedSender;
    params.command.senderIsOwner = senderIsOwner;

    const result = await handleExportSessionCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(buildExportSessionReplyMock).not.toHaveBeenCalled();
  });

  it("allows the owner to export a session", async () => {
    const params = buildInfoParams("/export-session", {
      commands: { text: true },
    } as OpenClawConfig);

    const result = await handleExportSessionCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "session exported" },
    });
    expect(buildExportSessionReplyMock).toHaveBeenCalledWith(params);
  });

  it("ignores trajectory export requests from unauthorized senders", async () => {
    const params = buildInfoParams("/export-trajectory", {
      commands: { text: true },
    } as OpenClawConfig);
    params.command.isAuthorizedSender = false;

    const result = await handleExportTrajectoryCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(buildExportTrajectoryCommandReplyMock).not.toHaveBeenCalled();
  });

  it("blocks authorized non-owners from exporting trajectory bundles", async () => {
    const params = buildInfoParams("/export-trajectory", {
      commands: { text: true },
    } as OpenClawConfig);
    params.command.senderIsOwner = false;

    const result = await handleExportTrajectoryCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(buildExportTrajectoryCommandReplyMock).not.toHaveBeenCalled();
  });

  it("returns sender details for /whoami", async () => {
    const result = await handleWhoamiCommand(
      buildInfoParams(
        "/whoami",
        {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        {
          SenderId: "12345",
          SenderUsername: "TestUser",
          ChatType: "direct",
        },
      ),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: whatsapp");
    expect(result?.reply?.text).toContain("User id: 12345");
    expect(result?.reply?.text).toContain("Username: @TestUser");
    expect(result?.reply?.text).toContain("AllowFrom: 12345");
  });

  it("returns usage for bare /skill without continuing to the agent", async () => {
    const params = buildInfoParams("/skill", {
      commands: { text: true },
    } as OpenClawConfig);
    params.skillCommands = [
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
      },
    ];

    const result = await handleSkillCommandUsage(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: /skill <name> [input]");
    expect(result?.reply?.text).toContain("Available: demo-skill");
  });

  it("returns an unknown skill reply for unmatched /skill targets", async () => {
    const params = buildInfoParams("/skill missing input", {
      commands: { text: true },
    } as OpenClawConfig);

    const result = await handleSkillCommandUsage(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Unknown skill: missing");
    expect(result?.reply?.text).toContain("Usage: /skill <name> [input]");
  });

  it("lets valid /skill invocations continue to the skill command path", async () => {
    const params = buildInfoParams("/skill demo_skill input", {
      commands: { text: true },
    } as OpenClawConfig);
    params.skillCommands = [
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
      },
    ];

    const result = await handleSkillCommandUsage(params, true);

    expect(result).toBeNull();
  });

  it("loads skills asynchronously before deciding named /skill invocations", async () => {
    const params = buildInfoParams("/skill demo_skill input", {
      commands: { text: true },
    } as OpenClawConfig);
    params.loadSkillCommands = vi.fn(async () => [
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
      },
    ]);

    const result = await handleSkillCommandUsage(params, true);

    expect(result).toBeNull();
    expect(params.loadSkillCommands).toHaveBeenCalledOnce();
    expect(listSkillCommandsForAgentsMock).not.toHaveBeenCalled();
  });

  it("loads skills when named /skill receives an empty precomputed command list", async () => {
    const params = buildInfoParams("/skill demo_skill input", {
      commands: { text: true },
    } as OpenClawConfig);
    params.skillCommands = [];
    params.loadSkillCommands = vi.fn(async () => [
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
      },
    ]);

    const result = await handleSkillCommandUsage(params, true);

    expect(result).toBeNull();
    expect(params.loadSkillCommands).toHaveBeenCalledOnce();
    expect(listSkillCommandsForAgentsMock).not.toHaveBeenCalled();
  });

  it("keeps an empty precomputed /skill command list authoritative without a loader", async () => {
    const params = buildInfoParams("/skill demo_skill input", {
      commands: { text: true },
    } as OpenClawConfig);
    params.skillCommands = [];

    const result = await handleSkillCommandUsage(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Unknown skill: demo_skill");
    expect(listSkillCommandsForAgentsMock).not.toHaveBeenCalled();
  });

  it("uses the canonical command sender identity for /whoami AllowFrom", async () => {
    const params = buildInfoParams(
      "/whoami",
      {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        SenderId: "123@lid",
        SenderUsername: "TestUser",
        SenderE164: "+15551234567",
        ChatType: "direct",
      },
    );
    params.command.senderId = "+15551234567";

    const result = await handleWhoamiCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("User id: 123@lid");
    expect(result?.reply?.text).toContain("AllowFrom: +15551234567");
  });

  it("returns expected details for /context commands", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const cases = [
      { commandBody: "/context", expectedText: ["/context list", "Inline shortcut"] },
      { commandBody: "/context list", expectedText: ["Injected workspace files:", "AGENTS.md"] },
      {
        commandBody: "/context detail",
        expectedText: ["Context breakdown (detailed)", "Top tools (schema size):"],
      },
    ] as const;

    for (const testCase of cases) {
      const result = await handleContextCommand(buildInfoParams(testCase.commandBody, cfg), true);
      expect(result?.shouldContinue).toBe(false);
      for (const expectedText of testCase.expectedText) {
        expect(result?.reply?.text).toContain(expectedText);
      }
    }
  });

  it("prefers the persisted session parent when routing /status context", async () => {
    const params = buildInfoParams(
      "/status",
      {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        ParentSessionKey: undefined,
      },
    );
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      parentSessionKey: "discord:group:parent-room",
    } as HandleCommandsParams["sessionEntry"];

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult?.shouldContinue).toBe(false);

    const statusReplyParams = firstMockArg(
      vi.mocked(buildStatusReply),
      "buildStatusReply",
    ) as Parameters<typeof buildStatusReply>[0];
    expect(statusReplyParams.parentSessionKey).toBe("discord:group:parent-room");
  });

  it("preserves the shared session store path when routing /status", async () => {
    const params = buildInfoParams("/status", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.storePath = "/tmp/target-session-store.json";

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult?.shouldContinue).toBe(false);
    const statusReplyParams = firstMockArg(
      vi.mocked(buildStatusReply),
      "buildStatusReply",
    ) as Parameters<typeof buildStatusReply>[0];
    expect(statusReplyParams.storePath).toBe("/tmp/target-session-store.json");
  });

  it("prefers the target session entry when routing /status", async () => {
    const params = buildInfoParams("/status", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      parentSessionKey: "wrapper-parent",
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      "agent:main:whatsapp:direct:12345": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        parentSessionKey: "target-parent",
      },
    };

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult?.shouldContinue).toBe(false);
    const statusReplyParams = firstMockArg(
      vi.mocked(buildStatusReply),
      "buildStatusReply",
    ) as Parameters<typeof buildStatusReply>[0];
    expect(statusReplyParams.sessionEntry?.sessionId).toBe("target-session");
    expect(statusReplyParams.sessionEntry?.parentSessionKey).toBe("target-parent");
    expect(statusReplyParams.parentSessionKey).toBe("target-parent");
  });

  it("forwards resolved fast mode to /status", async () => {
    const params = buildInfoParams("/status", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.resolvedFastMode = true;

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult?.shouldContinue).toBe(false);
    const statusReplyParams = firstMockArg(
      vi.mocked(buildStatusReply),
      "buildStatusReply",
    ) as Parameters<typeof buildStatusReply>[0];
    expect(statusReplyParams.resolvedFastMode).toBe(true);
  });

  it("routes /status plugins to the plugin health summary", async () => {
    const params = buildInfoParams("/status plugins", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);

    const statusResult = await handleStatusCommand(params, true);

    expect(statusResult).toEqual({
      shouldContinue: false,
      reply: { text: "plugins status reply" },
    });
    expect(buildStatusPluginsReply).toHaveBeenCalledWith({
      cfg: params.cfg,
      command: params.command,
      workspaceDir: params.workspaceDir,
    });
    expect(buildStatusReply).not.toHaveBeenCalled();
  });

  it("uses the canonical target session agent when listing /commands", async () => {
    const { handleCommandsListCommand } = await import("./commands-info.js");
    const params = buildInfoParams("/commands", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.agentId = "main";
    params.sessionKey = "agent:target:whatsapp:direct:12345";
    vi.mocked(resolveSessionAgentId).mockReturnValue("target");

    const result = await handleCommandsListCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    const listParams = firstMockArg(
      listSkillCommandsForAgentsMock,
      "listSkillCommandsForAgents",
    ) as { agentIds?: string[] };
    expect(listParams.agentIds).toEqual(["target"]);
  });
});
