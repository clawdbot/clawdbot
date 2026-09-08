// Tests system prompt command output and bundled prompt section selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import {
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../../agents/channel-tools.js";
import { collectRuntimeChannelCapabilities } from "../../agents/runtime-capabilities.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import { detectRuntimeShell } from "../../agents/shell-utils.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../../infra/os-summary.js";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const {
  collectRuntimeChannelCapabilitiesMock,
  createOpenClawCodingToolsMock,
  detectRuntimeShellMock,
  getMachineDisplayNameMock,
  logWarnMock,
  makeBootstrapWarnMock,
  resolveChannelMessageToolHintsMock,
  resolveChannelReactionGuidanceMock,
  resolveRuntimeOsLabelMock,
} = vi.hoisted(() => ({
  collectRuntimeChannelCapabilitiesMock: vi.fn(() => ["voice"]),
  createOpenClawCodingToolsMock: vi.fn(() => []),
  detectRuntimeShellMock: vi.fn(() => "zsh"),
  getMachineDisplayNameMock: vi.fn(async () => "test-host"),
  logWarnMock: vi.fn(),
  makeBootstrapWarnMock: vi.fn((params: { warn?: (message: string) => void }) => params.warn),
  resolveChannelMessageToolHintsMock: vi.fn(() => ["Use the message tool."]),
  resolveChannelReactionGuidanceMock: vi.fn(() => ({
    level: "minimal" as const,
    channel: "Telegram",
  })),
  resolveRuntimeOsLabelMock: vi.fn(() => "TestOS 1.0"),
}));

vi.mock("../../agents/channel-tools.js", () => ({
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

vi.mock("../../agents/sandbox.js", async () => {
  const { resolveSandboxRuntimeStatus } = await vi.importActual<
    typeof import("../../agents/sandbox/runtime-status.js")
  >("../../agents/sandbox/runtime-status.js");
  return {
    ensureSandboxWorkspaceForSession: vi.fn(async () => null),
    resolveSandboxRuntimeStatus,
  };
});

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
    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(collectRuntimeChannelCapabilities)).toHaveBeenCalledWith({
      cfg: params.cfg,
      channel: "telegram",
      accountId: "work",
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

  it.each([
    {
      sessionKey: "agent:target:telegram:direct:target-session",
      policySessionKey: undefined,
      policyAgentId: "target",
    },
    { sessionKey: "global", policySessionKey: undefined, policyAgentId: "target" },
    { sessionKey: "global", policySessionKey: "agent:main:group", policyAgentId: "main" },
  ])(
    "uses the sandbox policy owner $policyAgentId for $sessionKey / $policySessionKey",
    async ({ sessionKey, policySessionKey, policyAgentId }) => {
      const params = makeParams();
      params.ctx.SessionKey = "agent:main:telegram:slash-session";
      params.ctx.RuntimePolicySessionKey = policySessionKey;
      params.sessionKey = sessionKey;
      params.agentId = "target";
      params.cfg = { agents: { ownership: "explicit", entries: { main: {}, target: {} } } };

      const result = await resolveCommandsSystemPromptBundle(params);

      expect(result.sandboxRuntime).toMatchObject({
        agentId: "target",
        sessionKey,
        classificationAgentId: policyAgentId,
        classificationSessionKey: policySessionKey ?? sessionKey,
      });
    },
  );

  it("rejects an independent global sandbox policy without its own owner", async () => {
    const params = makeParams();
    params.agentId = "target";
    params.sessionKey = "agent:target:main";
    params.ctx.RuntimePolicySessionKey = "global";
    params.cfg = { agents: { ownership: "explicit", entries: { main: {}, target: {} } } };

    await expect(resolveCommandsSystemPromptBundle(params)).rejects.toMatchObject({
      code: "AGENT_SELECTION_REQUIRED",
    });
    expect(vi.mocked(ensureSandboxWorkspaceForSession)).not.toHaveBeenCalled();
  });

  it("uses the canonical target session agent for tool creation", async () => {
    const params = makeParams();
    params.agentId = "target";
    params.sessionKey = "agent:target:telegram:direct:target-session";

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
    params.agentId = "target";

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
    const params = makeParams();
    params.cfg = { agents: { defaults: { sandbox: { mode: "all" } } } };
    params.sessionKey = "agent:target:default";
    params.agentId = "target";
    params.ctx.SessionKey = "agent:source:default";
    params.elevated = {
      enabled: true,
      allowed: false,
      failures: [],
    };

    const result = await resolveCommandsSystemPromptBundle(params);

    expect(result.sandboxRuntime.sessionKey).toBe("agent:target:default");

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

  it("inspects the configured agent and canonical nested execution workspace", async () => {
    const params = makeParams();
    params.cfg = { agents: { defaults: { workspace: "/tmp/agent-workspace" } } };
    params.workspaceDir = "/tmp/task-checkout/packages/app";
    params.sessionEntry!.worktree = {
      id: "task",
      branch: "task",
      repoRoot: "/tmp/project",
      canonicalWorkspaceDir: "/tmp/project/packages/app",
    };
    await resolveCommandsSystemPromptBundle(params);
    expect(resolveReusableWorkspaceSkillSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/agent-workspace",
        executionWorkspaceDir: "/tmp/project/packages/app",
      }),
    );
  });

  it.each([false, true])("uses materialized sandbox skill paths (library=%s)", async (library) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-sandbox-skills-"));
    try {
      const workspaceDir = path.join(root, "workspace");
      const skillsWorkspaceDir = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(skillsWorkspaceDir, "skills", "gog");
      const hostSkillPath = "/host/skills/gog/SKILL.md";
      const hostSnapshot: SkillSnapshot = {
        prompt: "<available_skills>Host skill catalog</available_skills>",
        skills: [{ name: "gog" }],
        resolvedSkills: [
          {
            name: "gog",
            description: "Gog skill",
            filePath: hostSkillPath,
            baseDir: path.dirname(hostSkillPath),
            source: "openclaw-library",
            sourceInfo: createSyntheticSourceInfo(hostSkillPath, { source: "openclaw-library" }),
            disableModelInvocation: false,
          },
        ],
        ...(library
          ? {
              librarySelections: [
                { skillId: "test-pin", revision: "revision-1", name: "gog", ownerProfileId: null },
              ],
            }
          : {}),
      };
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: gog", "description: Gog skill", "---", "# Gog", ""].join("\n"),
        "utf8",
      );
      const params = makeParams();
      params.workspaceDir = workspaceDir;
      params.sessionKey = "global";
      params.agentId = "target";
      params.cfg = {
        agents: {
          ownership: "explicit",
          entries: {
            main: {},
            target: { workspace: path.join(root, "agent-workspace"), sandbox: { mode: "all" } },
          },
        },
      };
      vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue({
        workspaceDir,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir,
        skillUsagePaths: [
          {
            skillName: "gog",
            skillFile: hostSkillPath,
            readPath: path.join(skillDir, "SKILL.md"),
            skillSource: "unknown",
          },
        ],
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
        snapshot: hostSnapshot,
        shouldRefresh: false,
        snapshotVersion: "host-snapshot",
      } as never);

      const result = await resolveCommandsSystemPromptBundle(params);

      expect(vi.mocked(ensureSandboxWorkspaceForSession)).toHaveBeenCalledWith({
        skillsSnapshot: vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.results[0]?.value
          .snapshot,
        config: params.cfg,
        sessionKey: "global",
        agentId: "target",
        workspaceDir,
      });
      expect(result.skillsPrompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md",
      );
      expect(result.skillsPrompt).not.toContain(hostSkillPath);
      expect(vi.mocked(resolveReusableWorkspaceSkillSnapshot)).toHaveBeenCalledOnce();
      const promptParams = requireFirstArg(
        vi.mocked(buildAgentSystemPrompt),
        "buildAgentSystemPrompt",
      );
      expect(promptParams.skillsPrompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md",
      );
      expect(String(promptParams.skillsPrompt)).not.toContain(hostSkillPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves host skill snapshots for custom backends without a declared workdir", async () => {
    const params = makeParams();
    params.cfg = { agents: { defaults: { sandbox: { mode: "all" } } } };
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
