import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSubagentResult } from "../../agents/subagent-spawn.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createEmptyInlineDirectives } from "./commands-subagents.test-helpers.js";
import { handleSubagentsSpawnAction } from "./commands-subagents/action-spawn.js";
import type { HandleCommandsParams } from "./commands-types.js";

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
      directives: createEmptyInlineDirectives(),
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

function latestSpawnCall(): {
  options: Record<string, unknown>;
  context: Record<string, unknown>;
} {
  const call = spawnSubagentDirectMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected spawnSubagentDirect call");
  }
  const [options, context] = call;
  if (!options || typeof options !== "object" || !context || typeof context !== "object") {
    throw new Error("expected spawnSubagentDirect object args");
  }
  return {
    options: options as Record<string, unknown>,
    context: context as Record<string, unknown>,
  };
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
    expect(spawnSubagentDirectMock).toHaveBeenCalledOnce();
    const { options, context } = latestSpawnCall();
    expect(options.agentId).toBe("beta");
    expect(options.task).toBe("do the thing");
    expect(options.mode).toBe("run");
    expect(options.cleanup).toBe("keep");
    expect(options.expectsCompletionMessage).toBe(true);
    expect(context.agentSessionKey).toBe("agent:main:main");
    expect(context.agentChannel).toBe("whatsapp");
    expect(context.agentAccountId).toBe("default");
    expect(context.agentTo).toBe("channel:origin");
    expect(context.agentThreadId).toBe("thread-1");
  });

  it("passes --model through to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult({ modelApplied: true }));
    await handleSubagentsSpawnAction(
      buildContext({
        restTokens: ["beta", "do", "the", "thing", "--model", "openai/gpt-4o"],
      }),
    );
    const { options } = latestSpawnCall();
    expect(options.model).toBe("openai/gpt-4o");
    expect(options.task).toBe("do the thing");
  });

  it("passes --thinking through to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        restTokens: ["beta", "do", "the", "thing", "--thinking", "high"],
      }),
    );
    const { options } = latestSpawnCall();
    expect(options.thinking).toBe("high");
    expect(options.task).toBe("do the thing");
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
    const { context } = latestSpawnCall();
    expect(context.agentGroupId).toBe("group-1");
    expect(context.agentGroupChannel).toBe("#group-channel");
    expect(context.agentGroupSpace).toBe("workspace-1");
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
    const { context } = latestSpawnCall();
    expect(context.agentSessionKey).toBe("agent:main:target");
    expect(context.agentChannel).toBe("discord");
    expect(context.agentTo).toBe("channel:12345");
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
    let context = latestSpawnCall().context;
    expect(context.agentSessionKey).toBe("agent:main:target");
    expect(context.agentGroupId).toBe("wrapper-group");
    expect(context.agentGroupChannel).toBe("#wrapper");
    expect(context.agentGroupSpace).toBe("wrapper-space");

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

    context = latestSpawnCall().context;
    expect(context.agentSessionKey).toBe("agent:main:target");
    expect(context.agentGroupId).toBe("target-group");
    expect(context.agentGroupChannel).toBe("#target");
    expect(context.agentGroupSpace).toBe("target-space");
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
    expect(latestSpawnCall().context.agentTo).toBe("channel:manual");
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
