import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  compactEmbeddedPiSession: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: vi.fn(() => "Context 12.1k"),
  formatTokenCount: vi.fn((value: number) => `${value}`),
  incrementCompactionCount: vi.fn(),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  resolveFreshSessionTotalTokens: vi.fn(() => 12_345),
  resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
}));

const {
  compactEmbeddedPiSession,
  formatContextUsageShort,
  incrementCompactionCount,
  resolveSessionFilePathOptions,
} = await import("./commands-compact.runtime.js");
const { handleCompactCommand } = await import("./commands-compact.js");

function buildCompactParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      CommandBody: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: "owner",
      channel: "whatsapp",
      ownerList: [],
    },
    sessionKey: "agent:main:main",
    sessionStore: {},
    resolveDefaultThinkingLevel: async () => "medium",
  } as unknown as HandleCommandsParams;
}

function requireCompactEmbeddedPiSessionCall(index = 0) {
  const call = vi.mocked(compactEmbeddedPiSession).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`compactEmbeddedPiSession call ${index} missing`);
  }
  return call;
}

function requireResolveSessionAgentIdCall(index = 0) {
  const call = (
    resolveSessionAgentIdMock.mock.calls[index] as unknown as [unknown] | undefined
  )?.[0] as { sessionKey?: string; config?: OpenClawConfig } | undefined;
  if (!call) {
    throw new Error(`resolveSessionAgentId call ${index} missing`);
  }
  return call;
}

function requireResolveAgentDirCall(index = 0) {
  const call = resolveAgentDirMock.mock.calls[index] as [OpenClawConfig, string] | undefined;
  if (!call) {
    throw new Error(`resolveAgentDir call ${index} missing`);
  }
  return call;
}

function requireIncrementCompactionCountCall(index = 0) {
  const call = vi.mocked(incrementCompactionCount).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`incrementCompactionCount call ${index} missing`);
  }
  return call;
}

describe("handleCompactCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
    resolveSessionAgentIdMock.mockReturnValue("main");
  });

  it("returns null when command is not /compact", async () => {
    const result = await handleCompactCommand(
      buildCompactParams("/status", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result).toBeNull();
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("rejects unauthorized /compact commands", async () => {
    const params = buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);

    const result = await handleCompactCommand(
      {
        ...params,
        command: {
          ...params.command,
          isAuthorizedSender: false,
          senderId: "unauthorized",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: "/tmp/openclaw-session-store.json" },
        } as OpenClawConfig),
        ctx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          CommandSource: "text",
          CommandBody: "/compact: focus on decisions",
          From: "+15550001",
          To: "+15550002",
          SenderName: "Alice",
          SenderUsername: "alice_u",
          SenderE164: "+15551234567",
        },
        agentDir: "/tmp/openclaw-agent-compact",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          groupId: "group-1",
          groupChannel: "#general",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12345,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledOnce();
    const call = requireCompactEmbeddedPiSessionCall();
    expect(call.sessionId).toBe("session-1");
    expect(call.sessionKey).toBe("agent:main:main");
    expect(call.allowGatewaySubagentBinding).toBe(true);
    expect(call.trigger).toBe("manual");
    expect(call.customInstructions).toBe("focus on decisions");
    expect(call.messageChannel).toBe("whatsapp");
    expect(call.groupId).toBe("group-1");
    expect(call.groupChannel).toBe("#general");
    expect(call.groupSpace).toBe("workspace-1");
    expect(call.spawnedBy).toBe("agent:main:parent");
    expect(call.senderId).toBe("owner");
    expect(call.senderName).toBe("Alice");
    expect(call.senderUsername).toBe("alice_u");
    expect(call.senderE164).toBe("+15551234567");
    expect(call.agentDir).toBe("/tmp/openclaw-agent-compact");
  });

  it("uses the canonical session agent when resolving the compaction session file", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("target");
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: "/tmp/openclaw-session-store.json" },
    } as OpenClawConfig;

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        agentId: "main",
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(resolveSessionAgentIdMock).toHaveBeenCalledOnce();
    const resolveCall = requireResolveSessionAgentIdCall();
    expect(resolveCall.sessionKey).toBe("agent:target:whatsapp:direct:12345");
    expect(resolveCall.config).toBe(cfg);
    expect(vi.mocked(resolveSessionFilePathOptions)).toHaveBeenCalledWith({
      agentId: "target",
      storePath: undefined,
    });
  });

  it("uses the canonical session agent directory for compaction runtime inputs", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("target");
    resolveAgentDirMock.mockReturnValue("/tmp/target-agent");
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        agentId: "main",
        agentDir: "/tmp/main-agent",
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedPiSessionCall().agentDir).toBe("/tmp/target-agent");
    expect(resolveAgentDirMock).toHaveBeenCalledOnce();
    const [configArg, agentIdArg] = requireResolveAgentDirCall();
    expect(configArg).toBe(cfg);
    expect(agentIdArg).toBe("target");
  });

  it("prefers the target session entry for compaction runtime metadata", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
          groupId: "wrapper-group",
          groupChannel: "#wrapper",
          space: "wrapper-space",
          spawnedBy: "agent:wrapper",
          skillsSnapshot: { prompt: "wrapper", skills: [] },
          contextTokens: 111,
        },
        sessionStore: {
          "agent:target:whatsapp:direct:12345": {
            sessionId: "target-session",
            updatedAt: Date.now(),
            groupId: "target-group",
            groupChannel: "#target",
            space: "target-space",
            spawnedBy: "agent:target-parent",
            skillsSnapshot: { prompt: "target", skills: [] },
            contextTokens: 222,
          },
        },
      } as HandleCommandsParams,
      true,
    );

    const call = requireCompactEmbeddedPiSessionCall();
    expect(call.sessionId).toBe("target-session");
    expect(call.groupId).toBe("target-group");
    expect(call.groupChannel).toBe("#target");
    expect(call.groupSpace).toBe("target-space");
    expect(call.spawnedBy).toBe("agent:target-parent");
    expect(call.skillsSnapshot).toEqual({ prompt: "target", skills: [] });
  });

  it("prefers the target session entry when incrementing compaction count", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 999,
        tokensAfter: 321,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
        },
        sessionStore: {
          "agent:target:whatsapp:direct:12345": {
            sessionId: "target-session",
            updatedAt: Date.now(),
          },
        },
      } as HandleCommandsParams,
      true,
    );

    const call = requireIncrementCompactionCountCall();
    if (!call.sessionEntry) {
      throw new Error("incrementCompactionCount sessionEntry missing");
    }
    expect(call.sessionEntry.sessionId).toBe("target-session");
    expect(call.tokensAfter).toBe(321);
  });

  it("resolves /compact context budget from the active Codex runtime config instead of stale session metadata", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 199_000,
        tokensAfter: 56_000,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: { id: "codex" },
                },
              },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          models: {
            providers: {
              "openai-codex": {
                models: [{ id: "gpt-5.5", contextWindow: 258_000 }],
              },
            },
          },
        } as unknown as OpenClawConfig),
        provider: "openai",
        model: "openai/gpt-5.5",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "live-session",
          updatedAt: Date.now(),
          contextTokens: 400_000,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedPiSessionCall().contextTokenBudget).toBe(258_000);
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(56_000, 258_000);
  });
});
