// Tests system prompt command output and bundled prompt section selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../../agents/channel-tools.js";
import { collectRuntimeChannelCapabilities } from "../../agents/runtime-capabilities.js";
import {
  ensureSandboxWorkspaceForSession,
  resolveSandboxRuntimeStatus,
} from "../../agents/sandbox.js";
import { detectRuntimeShell } from "../../agents/shell-utils.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import type { ChannelThreadingContext } from "../../channels/plugins/types.public.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../../infra/os-summary.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const {
  collectRuntimeChannelCapabilitiesMock,
  createOpenClawCodingToolsMock,
  detectRuntimeShellMock,
  getChannelPluginMock,
  getMachineDisplayNameMock,
  listChannelSupportedActionsMock,
  logWarnMock,
  makeBootstrapWarnMock,
  resolveChannelMessageToolHintsMock,
  resolveChannelReactionGuidanceMock,
  resolveRuntimeOsLabelMock,
} = vi.hoisted(() => ({
  collectRuntimeChannelCapabilitiesMock: vi.fn(() => ["voice"]),
  createOpenClawCodingToolsMock: vi.fn(() => []),
  detectRuntimeShellMock: vi.fn(() => "zsh"),
  getChannelPluginMock: vi.fn(),
  getMachineDisplayNameMock: vi.fn(async () => "test-host"),
  listChannelSupportedActionsMock: vi.fn(() => ["send", "react"]),
  logWarnMock: vi.fn(),
  makeBootstrapWarnMock: vi.fn((params: { warn?: (message: string) => void }) => params.warn),
  resolveChannelMessageToolHintsMock: vi.fn(() => ["Use the message tool."]),
  resolveChannelReactionGuidanceMock: vi.fn(() => ({
    level: "minimal" as const,
    channel: "Telegram",
  })),
  resolveRuntimeOsLabelMock: vi.fn(() => "TestOS 1.0"),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../agents/channel-tools.js", () => ({
  listChannelSupportedActions: listChannelSupportedActionsMock,
  resolveChannelMessageToolHints: resolveChannelMessageToolHintsMock,
  resolveChannelReactionGuidance: resolveChannelReactionGuidanceMock,
}));

vi.mock("../../agents/runtime-capabilities.js", () => ({
  collectRuntimeChannelCapabilities: collectRuntimeChannelCapabilitiesMock,
}));

vi.mock("../../agents/shell-utils.js", () => ({
  detectRuntimeShell: detectRuntimeShellMock,
}));

vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: getMachineDisplayNameMock,
}));

vi.mock("../../infra/os-summary.js", () => ({
  resolveRuntimeOsLabel: resolveRuntimeOsLabelMock,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ warn: logWarnMock })),
}));

vi.mock("../../agents/bootstrap-files.js", () => ({
  makeBootstrapWarn: makeBootstrapWarnMock,
  resolveBootstrapContextForRun: vi.fn(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  })),
}));

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession: vi.fn(async () => null),
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false, mode: "off" })),
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => false),
}));

vi.mock("../../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: vi.fn(() => ({
    snapshot: { prompt: "", skills: [], resolvedSkills: [] },
    shouldRefresh: false,
    snapshotVersion: "test-snapshot",
  })),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => undefined),
  resolveSessionAgentId: vi.fn(({ agentId }: { agentId?: string }) => agentId ?? "main"),
  resolveSessionAgentIds: vi.fn(() => ({ sessionAgentId: "main" })),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5" })),
}));

vi.mock("../../agents/system-prompt-params.js", () => ({
  buildSystemPromptParams: vi.fn(() => ({
    runtimeInfo: { host: "unknown", os: "unknown", arch: "unknown", node: process.version },
    userTimezone: "UTC",
    userDate: "2026-01-05",
  })),
}));

vi.mock("../../agents/system-prompt.js", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: createOpenClawCodingToolsMock,
}));

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

function makeParams(): HandleCommandsParams {
  return {
    ctx: {
      SessionKey: "agent:main:default",
      SenderId: "sender-1",
      SenderName: "Alice",
      SenderUsername: "alice_u",
      SenderE164: "+15551234567",
    },
    cfg: {},
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderId: "sender-1",
      senderIsOwner: true,
      isAuthorizedSender: true,
      rawBodyNormalized: "/context",
      commandBodyNormalized: "/context",
    },
    directives: {},
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
    agentId: "main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      groupId: "group-1",
      groupChannel: "#general",
      space: "guild-1",
      spawnedBy: "agent:parent",
    },
    sessionKey: "agent:main:default",
    workspaceDir: "/tmp/workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

function requireFirstArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const arg = mockFn.mock.calls.at(0)?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} to be called`);
  }
  return arg;
}

describe("resolveCommandsSystemPromptBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChannelPluginMock.mockReset();
    createOpenClawCodingToolsMock.mockClear();
    createOpenClawCodingToolsMock.mockReturnValue([]);
    vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue(null);
    vi.mocked(resolveReusableWorkspaceSkillSnapshot).mockReturnValue({
      snapshot: { prompt: "", skills: [], resolvedSkills: [] },
      shouldRefresh: false,
      snapshotVersion: "test-snapshot",
    } as never);
  });

  it("opts command tool builds into gateway subagent binding", async () => {
    await resolveCommandsSystemPromptBundle(makeParams());

    const toolParams = requireFirstArg(
      vi.mocked(createOpenClawCodingTools),
      "createOpenClawCodingTools",
    );
    expect(toolParams.allowGatewaySubagentBinding).toBe(true);
    expect(toolParams.sessionKey).toBe("agent:main:default");
    expect(toolParams.workspaceDir).toBe("/tmp/workspace");
    expect(toolParams.messageProvider).toBe("telegram");
    expect(toolParams.senderId).toBe("sender-1");
    expect(toolParams.senderName).toBe("Alice");
    expect(toolParams.senderUsername).toBe("alice_u");
    expect(toolParams.senderE164).toBe("+15551234567");
  });

  it("includes the current communication channel in reconstructed prompts", async () => {
    const params = makeParams();
    params.ctx.AccountId = "work";
    params.ctx.ChatType = "group";
    params.ctx.MessageSidFull = "message-1";
    params.ctx.OriginatingChannel = "telegram";
    params.ctx.OriginatingTo = "telegram:-1003841603622:topic:928";
    params.ctx.MessageThreadId = 928;
    params.command.accountId = "work";
    params.command.to = "slash:8460800771";
    getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({ context }: { context: ChannelThreadingContext }) => ({
          currentChannelId: context.To,
          currentThreadTs:
            context.MessageThreadId == null ? undefined : String(context.MessageThreadId),
        }),
      },
    });

    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(collectRuntimeChannelCapabilities)).toHaveBeenCalledWith({
      cfg: params.cfg,
      channel: "telegram",
      accountId: "work",
    });
    expect(vi.mocked(listChannelSupportedActions)).toHaveBeenCalledWith({
      cfg: params.cfg,
      channel: "telegram",
      currentChannelId: "telegram:-1003841603622:topic:928",
      currentThreadTs: "928",
      currentMessageId: "message-1",
      accountId: "work",
      sessionKey: "agent:main:default",
      sessionId: "session-1",
      agentId: "main",
      requesterSenderId: "sender-1",
      senderIsOwner: true,
    });
    expect(vi.mocked(resolveChannelReactionGuidance)).toHaveBeenCalledWith({
      cfg: params.cfg,
      channel: "telegram",
      accountId: "work",
    });
    expect(vi.mocked(resolveChannelMessageToolHints)).toHaveBeenCalledWith({
      cfg: params.cfg,
      channel: "telegram",
      accountId: "work",
    });
    const runtimeParams = requireFirstArg(
      vi.mocked(buildSystemPromptParams),
      "buildSystemPromptParams",
    );
    expect(runtimeParams.runtime).toEqual(
      expect.objectContaining({
        host: "test-host",
        os: "TestOS 1.0",
        arch: os.arch(),
        shell: "zsh",
        channel: "telegram",
        chatType: "group",
        capabilities: ["voice"],
        channelActions: ["send", "react"],
      }),
    );
    const promptParams = requireFirstArg(
      vi.mocked(buildAgentSystemPrompt),
      "buildAgentSystemPrompt",
    );
    expect(promptParams.reactionGuidance).toEqual({ level: "minimal", channel: "Telegram" });
    expect(promptParams.messageToolHints).toEqual(["Use the message tool."]);
    expect(vi.mocked(getMachineDisplayName)).toHaveBeenCalledOnce();
    expect(vi.mocked(resolveRuntimeOsLabel)).toHaveBeenCalledOnce();
    expect(vi.mocked(detectRuntimeShell)).toHaveBeenCalledOnce();
  });

  it("honors provider adapters that suppress generic message reply targets", async () => {
    const params = makeParams();
    params.command.channel = "googlechat";
    params.ctx.OriginatingChannel = "googlechat";
    params.ctx.OriginatingTo = "googlechat:spaces/AAA";
    params.ctx.MessageSidFull = "spaces/AAA/messages/msg-1";
    params.ctx.ReplyToIdFull = "spaces/AAA/threads/full";
    getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({ context }: { context: ChannelThreadingContext }) => ({
          currentChannelId: context.To?.replace(/^googlechat:/, ""),
          currentMessageId: undefined,
          currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
        }),
      },
    });

    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(listChannelSupportedActions)).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "googlechat",
        currentChannelId: "spaces/AAA",
        currentThreadTs: "spaces/AAA/threads/full",
        currentMessageId: undefined,
      }),
    );
  });

  it("retains command route fallbacks when no threading adapter can resolve them", async () => {
    const params = makeParams();
    params.ctx.NativeChannelId = "native-chat-1";
    params.ctx.ChatId = "fallback-chat-1";
    params.ctx.MessageThreadId = 928;
    params.ctx.MessageSid = "message-1";
    params.command.to = "command-chat-1";

    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(listChannelSupportedActions)).toHaveBeenCalledWith(
      expect.objectContaining({
        currentChannelId: "native-chat-1",
        currentThreadTs: "928",
        currentMessageId: "message-1",
      }),
    );
  });

  it("does not treat the channel provider as a conversation target", async () => {
    const params = makeParams();
    params.command.channelId = "telegram";

    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(listChannelSupportedActions)).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        currentChannelId: undefined,
      }),
    );
  });

  it("uses the canonical target session for sandbox runtime resolution", async () => {
    const params = makeParams();
    params.ctx.SessionKey = "agent:main:telegram:slash-session";
    params.sessionKey = "agent:main:telegram:direct:target-session";

    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(resolveSandboxRuntimeStatus)).toHaveBeenCalledWith({
      cfg: params.cfg,
      sessionKey: "agent:main:telegram:direct:target-session",
    });
  });

  it("uses the canonical target session agent for tool creation", async () => {
    const params = makeParams();
    params.agentId = "main";
    params.sessionKey = "agent:target:telegram:direct:target-session";
    vi.mocked(resolveSessionAgentIds).mockReturnValue({
      sessionAgentId: "target",
      defaultAgentId: "main",
    });

    await resolveCommandsSystemPromptBundle(params);

    const toolParams = requireFirstArg(
      vi.mocked(createOpenClawCodingTools),
      "createOpenClawCodingTools",
    );
    expect(toolParams.agentId).toBe("target");
    expect(toolParams.sessionKey).toBe("agent:target:telegram:direct:target-session");
    const bootstrapParams = requireFirstArg(
      vi.mocked(resolveBootstrapContextForRun),
      "resolveBootstrapContextForRun",
    );
    expect(bootstrapParams.agentId).toBe("target");
  });

  it("records bootstrap exclusions for generated command prompts", async () => {
    const params = makeParams();

    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(makeBootstrapWarn)).toHaveBeenCalledWith({
      sessionLabel: "agent:main:default",
      workspaceDir: "/tmp/workspace",
      warn: expect.any(Function),
    });
    const bootstrapParams = requireFirstArg(
      vi.mocked(resolveBootstrapContextForRun),
      "resolveBootstrapContextForRun",
    );
    const warn = bootstrapParams.warn as ((message: string) => void) | undefined;
    expect(warn).toEqual(expect.any(Function));
    warn?.("excluding automatic memory context");
    expect(logWarnMock).toHaveBeenCalledWith("excluding automatic memory context");
  });

  it("prefers the target session entry for bootstrap and tool metadata", async () => {
    const params = makeParams();
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      groupId: "wrapper-group",
      groupChannel: "#wrapper",
      space: "wrapper-space",
      spawnedBy: "agent:wrapper",
    };
    params.sessionStore = {
      "agent:target:telegram:direct:target-session": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        groupId: "target-group",
        groupChannel: "#target",
        space: "target-space",
        spawnedBy: "agent:target-parent",
      },
    } as HandleCommandsParams["sessionStore"];
    params.sessionKey = "agent:target:telegram:direct:target-session";

    await resolveCommandsSystemPromptBundle(params);

    const bootstrapParams = requireFirstArg(
      vi.mocked(resolveBootstrapContextForRun),
      "resolveBootstrapContextForRun",
    );
    expect(bootstrapParams.sessionId).toBe("target-session");
    const runtimeParams = requireFirstArg(
      vi.mocked(buildSystemPromptParams),
      "buildSystemPromptParams",
    );
    expect(runtimeParams.runtime).toEqual(
      expect.objectContaining({
        sessionKey: "agent:target:telegram:direct:target-session",
        sessionId: "target-session",
      }),
    );
    const toolParams = requireFirstArg(
      vi.mocked(createOpenClawCodingTools),
      "createOpenClawCodingTools",
    );
    expect(toolParams.groupId).toBe("target-group");
    expect(toolParams.groupChannel).toBe("#target");
    expect(toolParams.groupSpace).toBe("target-space");
    expect(toolParams.spawnedBy).toBe("agent:target-parent");
  });

  it("uses the resolved session key and forwards full-access block reasons", async () => {
    vi.mocked(resolveSandboxRuntimeStatus).mockImplementation(({ sessionKey }) => {
      expect(sessionKey).toBe("agent:target:default");
      return { sandboxed: true, mode: "workspace-write" } as never;
    });

    const params = makeParams();
    params.sessionKey = "agent:target:default";
    params.ctx.SessionKey = "agent:source:default";
    params.elevated = {
      enabled: true,
      allowed: false,
      failures: [],
    };

    await resolveCommandsSystemPromptBundle(params);

    const promptParams = requireFirstArg(
      vi.mocked(buildAgentSystemPrompt),
      "buildAgentSystemPrompt",
    );
    const sandboxInfo = promptParams.sandboxInfo as
      | { enabled?: unknown; elevated?: Record<string, unknown> }
      | undefined;
    expect(sandboxInfo?.enabled).toBe(true);
    expect(sandboxInfo?.elevated?.fullAccessAvailable).toBe(false);
    expect(sandboxInfo?.elevated?.fullAccessBlockedReason).toBe("host-policy");
  });

  it("uses materialized sandbox skill paths for sandbox command prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-sandbox-skills-"));
    try {
      const workspaceDir = path.join(root, "workspace");
      const skillsWorkspaceDir = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(skillsWorkspaceDir, "skills", "gog");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: gog", "description: Gog skill", "---", "# Gog", ""].join("\n"),
        "utf8",
      );
      const params = makeParams();
      params.workspaceDir = workspaceDir;
      vi.mocked(resolveSandboxRuntimeStatus).mockReturnValue({
        sandboxed: true,
        mode: "workspace-write",
      } as never);
      vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue({
        workspaceDir,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir,
        skillsEligibility: {
          remote: {
            platforms: ["linux"],
            hasBin: () => true,
            hasAnyBin: () => true,
            note: "sandbox",
          },
        },
        workspaceAccess: "rw",
      } as never);
      vi.mocked(resolveReusableWorkspaceSkillSnapshot).mockReturnValue({
        snapshot: {
          prompt:
            "<available_skills>~/.npm-global/lib/node_modules/openclaw/skills/gog/SKILL.md</available_skills>",
          skills: [],
          resolvedSkills: [],
        },
        shouldRefresh: false,
        snapshotVersion: "host-snapshot",
      } as never);

      const result = await resolveCommandsSystemPromptBundle(params);

      expect(result.skillsPrompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md",
      );
      expect(result.skillsPrompt).not.toContain("~/.npm-global");
      expect(vi.mocked(resolveReusableWorkspaceSkillSnapshot)).not.toHaveBeenCalled();
      const promptParams = requireFirstArg(
        vi.mocked(buildAgentSystemPrompt),
        "buildAgentSystemPrompt",
      );
      expect(promptParams.skillsPrompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md",
      );
      expect(String(promptParams.skillsPrompt)).not.toContain("~/.npm-global");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves host skill snapshots for custom backends without a declared workdir", async () => {
    const params = makeParams();
    vi.mocked(resolveSandboxRuntimeStatus).mockReturnValue({
      sandboxed: true,
      mode: "workspace-write",
    } as never);
    vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue({
      workspaceDir: params.workspaceDir,
      skillsWorkspaceDir: "/tmp/sandbox-skills",
      workspaceAccess: "rw",
    });

    const result = await resolveCommandsSystemPromptBundle(params);

    expect(result.skillsPrompt).toBe("");
    expect(vi.mocked(resolveReusableWorkspaceSkillSnapshot)).toHaveBeenCalledOnce();
  });

  it("uses config-backed prompt settings for the target agent", async () => {
    vi.mocked(resolveSandboxRuntimeStatus).mockReturnValue({
      sandboxed: false,
      mode: "off",
    } as never);
    createOpenClawCodingToolsMock.mockReturnValue([{ name: "sessions_spawn" }] as never);
    const params = makeParams();
    params.cfg = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "prefer",
          },
        },
      },
    };

    await resolveCommandsSystemPromptBundle(params);

    const promptParams = requireFirstArg(
      vi.mocked(buildAgentSystemPrompt),
      "buildAgentSystemPrompt",
    );
    expect(promptParams.subagentDelegationMode).toBe("prefer");
    expect(promptParams.toolNames).toEqual(["sessions_spawn"]);
  });
});
