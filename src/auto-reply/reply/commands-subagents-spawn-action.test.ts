import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSubagentResult } from "../../agents/subagent-spawn.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { handleSubagentsSpawnAction } from "./commands-subagents/action-spawn.js";
import type { HandleCommandsParams } from "./commands-types.js";
import type { InlineDirectives } from "./directive-handling.js";

const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
  SUBAGENT_SPAWN_MODES: ["run", "session"],
}));

function acceptedResult(overrides?: Partial<SpawnSubagentResult>): SpawnSubagentResult {
  return {
    status: "accepted",
    childSessionKey: "agent:beta:subagent:test-uuid",
    runId: "run-spawn-1",
    ...overrides,
  };
}

function forbiddenResult(error: string): SpawnSubagentResult {
  return {
    status: "forbidden",
    error,
  };
}

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function buildContext(params?: {
  cfg?: OpenClawConfig;
  requesterKey?: string;
  restTokens?: string[];
  commandTo?: string | undefined;
  context?: Partial<HandleCommandsParams["ctx"]>;
  sessionEntry?: SessionEntry | undefined;
}) {
  const directives: InlineDirectives = {
    cleaned: "",
    hasThinkDirective: false,
    hasVerboseDirective: false,
    hasFastDirective: false,
    hasReasoningDirective: false,
    hasTraceDirective: false,
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasExecOptions: false,
    invalidExecHost: false,
    invalidExecSecurity: false,
    invalidExecAsk: false,
    invalidExecNode: false,
    hasStatusDirective: false,
    hasModelDirective: false,
    hasQueueDirective: false,
    queueReset: false,
    hasQueueOptions: false,
  };
  const ctx = {
    OriginatingChannel: "whatsapp",
    OriginatingTo: "channel:origin",
    AccountId: "default",
    MessageThreadId: "thread-1",
    ...params?.context,
  };
  return {
    params: {
      cfg: params?.cfg ?? baseCfg,
      ctx,
      command: {
        surface: "whatsapp",
        channel: "whatsapp",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        rawBodyNormalized: "",
        commandBodyNormalized: "",
        to: params?.commandTo ?? "channel:command",
      },
      directives,
      elevated: { enabled: false, allowed: false, failures: [] },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-subagents-spawn",
      defaultGroupActivation: () => "mention",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      provider: "whatsapp",
      model: "test-model",
      contextTokens: 0,
      isGroup: true,
      ...(params?.sessionEntry ? { sessionEntry: params.sessionEntry } : {}),
    },
    handledPrefix: "/subagents",
    requesterKey: params?.requesterKey ?? "agent:main:main",
    runs: [],
    restTokens: params?.restTokens ?? ["beta", "do", "the", "thing"],
  } satisfies Parameters<typeof handleSubagentsSpawnAction>[0];
}

describe("subagents spawn action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows usage when agentId is missing", async () => {
    const result = await handleSubagentsSpawnAction(buildContext({ restTokens: [] }));
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
      },
    });
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("shows usage when task is missing", async () => {
    const result = await handleSubagentsSpawnAction(buildContext({ restTokens: ["beta"] }));
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
      },
    });
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("spawns a subagent and formats the success reply", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const result = await handleSubagentsSpawnAction(buildContext());
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Spawned subagent beta (session agent:beta:subagent:test-uuid, run run-spaw).",
      },
    });
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "beta",
        task: "do the thing",
        mode: "run",
        cleanup: "keep",
        expectsCompletionMessage: true,
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
        agentChannel: "whatsapp",
        agentAccountId: "default",
        agentTo: "channel:origin",
        agentThreadId: "thread-1",
      }),
    );
  });

  it("passes --model through to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult({ modelApplied: true }));
    await handleSubagentsSpawnAction(
      buildContext({
        restTokens: ["beta", "do", "the", "thing", "--model", "openai/gpt-4o"],
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-4o",
        task: "do the thing",
      }),
      expect.anything(),
    );
  });

  it("passes --thinking through to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        restTokens: ["beta", "do", "the", "thing", "--thinking", "high"],
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: "high",
        task: "do the thing",
      }),
      expect.anything(),
    );
  });

  it("passes group context from the session entry", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          groupId: "group-1",
          groupChannel: "#group-channel",
          space: "workspace-1",
        },
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentGroupId: "group-1",
        agentGroupChannel: "#group-channel",
        agentGroupSpace: "workspace-1",
      }),
    );
  });

  it("uses the requester key chosen by earlier routing", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        requesterKey: "agent:main:target",
        context: {
          CommandSource: "native",
          CommandTargetSessionKey: "agent:main:target",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:12345",
        },
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentSessionKey: "agent:main:target",
        agentChannel: "discord",
        agentTo: "channel:12345",
      }),
    );
  });

  it("prefers the requester-key session entry for group metadata", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        requesterKey: "agent:main:target",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
          groupId: "wrapper-group",
          groupChannel: "#wrapper",
          space: "wrapper-space",
        },
      }),
    );
    const call = spawnSubagentDirectMock.mock.calls.at(-1);
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        agentSessionKey: "agent:main:target",
        agentGroupId: "wrapper-group",
        agentGroupChannel: "#wrapper",
        agentGroupSpace: "wrapper-space",
      }),
    );

    spawnSubagentDirectMock.mockClear();
    await handleSubagentsSpawnAction({
      ...buildContext({
        requesterKey: "agent:main:target",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
          groupId: "wrapper-group",
          groupChannel: "#wrapper",
          space: "wrapper-space",
        },
      }),
      params: {
        ...buildContext({
          requesterKey: "agent:main:target",
          sessionEntry: {
            sessionId: "wrapper-session",
            updatedAt: Date.now(),
            groupId: "wrapper-group",
            groupChannel: "#wrapper",
            space: "wrapper-space",
          },
        }).params,
        sessionStore: {
          "agent:main:target": {
            sessionId: "target-session",
            updatedAt: Date.now(),
            groupId: "target-group",
            groupChannel: "#target",
            space: "target-space",
          },
        },
      },
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentSessionKey: "agent:main:target",
        agentGroupId: "target-group",
        agentGroupChannel: "#target",
        agentGroupSpace: "target-space",
      }),
    );
  });

  it("falls back to OriginatingTo when command.to is missing", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        commandTo: undefined,
        context: {
          OriginatingChannel: "whatsapp",
          OriginatingTo: "channel:manual",
          To: "channel:fallback-from-to",
        },
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentTo: "channel:manual",
      }),
    );
  });

  it("formats forbidden spawn failures", async () => {
    spawnSubagentDirectMock.mockResolvedValue(
      forbiddenResult("agentId is not allowed for sessions_spawn (allowed: alpha)"),
    );
    const result = await handleSubagentsSpawnAction(buildContext());
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Spawn failed: agentId is not allowed for sessions_spawn (allowed: alpha)",
      },
    });
  });
});
