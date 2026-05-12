import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { createOpenClawCodingTools } from "../../agents/pi-tools.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const { createOpenClawCodingToolsMock } = vi.hoisted(() => ({
  createOpenClawCodingToolsMock: vi.fn(() => []),
}));

vi.mock("../../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: vi.fn(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  })),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false, mode: "off" })),
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => ({ prompt: "", skills: [], resolvedSkills: [] })),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => "test-snapshot"),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => undefined),
  resolveSessionAgentIds: vi.fn(() => ({ sessionAgentId: "main" })),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5" })),
}));

vi.mock("../../agents/system-prompt-params.js", () => ({
  buildSystemPromptParams: vi.fn(() => ({
    runtimeInfo: { host: "unknown", os: "unknown", arch: "unknown", node: process.version },
    userTimezone: "UTC",
    userTime: "12:00 PM",
    userTimeFormat: "12h",
  })),
}));

vi.mock("../../agents/system-prompt.js", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../../agents/pi-tools.js", () => ({
  createOpenClawCodingTools: createOpenClawCodingToolsMock,
}));

vi.mock("../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => false),
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
