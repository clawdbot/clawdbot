// Tests compact command behavior for session compaction and reply status.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import {
  abortEmbeddedAgentRun,
  buildCompactParams,
  compactEmbeddedAgentSession,
  formatContextUsageShort,
  handleCompactCommand,
  incrementCompactionCount,
  requireCompactEmbeddedAgentSessionCall,
  requireIncrementCompactionCountCall,
  requireResolveAgentDirCall,
  requireResolveSessionAgentIdCall,
  resetCompactCommandMocks,
  waitForEmbeddedAgentRunEnd,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

describe("handleCompactCommand", () => {
  beforeEach(resetCompactCommandMocks);

  it("returns null when command is not /compact", async () => {
    const result = await handleCompactCommand(
      buildCompactParams("/status", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result).toBeNull();
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
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
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    const abortController = new AbortController();

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
          commandText: "/compact: focus on decisions",
          From: "+15550001",
          To: "+15550002",
          SenderName: "Alice",
          SenderUsername: "alice_u",
          SenderE164: "+15551234567",
        },
        agentDir: "/tmp/openclaw-agent-compact",
        opts: { abortSignal: abortController.signal },
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          groupId: "group-1",
          groupChannel: "#general",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12345,
          authProfileOverride: "github-copilot:work",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
    const call = requireCompactEmbeddedAgentSessionCall();
    expect(call.sessionId).toBe("session-1");
    expect(call.abortSignal).toBe(abortController.signal);
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
    expect(call.authProfileId).toBe("github-copilot:work");
    expect(call.authProfileIdSource).toBe("user");
    expect(vi.mocked(abortEmbeddedAgentRun)).not.toHaveBeenCalled();
    expect(vi.mocked(waitForEmbeddedAgentRunEnd)).not.toHaveBeenCalled();
  });

  it("keeps the verified current owner in bounded manual-compaction prompt guidance", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    const ownerIds = Array.from({ length: 24 }, (_, index) => `owner-${index}`);
    const params = buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.command = {
      ...params.command,
      ownerList: ownerIds,
      senderId: "owner-23",
      senderIsOwner: true,
    };
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    await handleCompactCommand(params, true);

    const call = requireCompactEmbeddedAgentSessionCall();
    expect(call.ownerNumbers).toHaveLength(16);
    expect(call.ownerNumbers?.at(-1)).toBe("owner-23");
    expect(call).not.toHaveProperty("senderIsOwner");
    expect(params.command.ownerList).toEqual(ownerIds);
  });

  it("treats already-under-target manual compaction as skipped", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "already under target",
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction skipped: context is already under the compaction target • Context 12.1k",
    );
    expect(result?.reply?.isStatusNotice).toBe(true);
    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
  });

  it("does not hide a failed manual compaction with an empty-transcript reason", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no real conversation messages",
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction failed: nothing compactable in this session yet • Context 12.1k",
    );
    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
  });

  it("treats already_compacted manual compaction as skipped", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "already_compacted",
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction skipped: session is already compacted • Context 12.1k",
    );
    expect(result?.reply?.isStatusNotice).toBe(true);
  });

  it("uses the canonical session agent when resolving the compaction session file", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
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
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionTarget: {
          agentId: "target",
          sessionId: "session-1",
          sessionKey: "agent:target:whatsapp:direct:12345",
          storePath: "/tmp/openclaw-session-store.json",
        },
      }),
    );
  });

  it("keeps the selected agent when compacting an ambiguous global session", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("marie-clawndo");
    const cfg = {
      agents: {
        entries: {
          main: {},
          "marie-clawndo": {},
        },
      },
    } as OpenClawConfig;

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        agentId: "marie-clawndo",
        sessionKey: "global",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "global",
      config: cfg,
      agentId: "marie-clawndo",
    });
    expect(requireCompactEmbeddedAgentSessionCall().sessionTarget).toMatchObject({
      agentId: "marie-clawndo",
    });
  });

  it("uses the resolved command store for compaction", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: "/tmp/default-sessions.json" },
    } as OpenClawConfig;

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        storePath: "/tmp/scoped-sessions.json",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionTarget: expect.objectContaining({
          storePath: "/tmp/scoped-sessions.json",
        }),
      }),
    );
  });

  it("uses the canonical session agent directory for compaction runtime inputs", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
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

    expect(requireCompactEmbeddedAgentSessionCall().agentDir).toBe("/tmp/target-agent");
    expect(resolveAgentDirMock).toHaveBeenCalledOnce();
    const [configArg, agentIdArg] = requireResolveAgentDirCall();
    expect(configArg).toBe(cfg);
    expect(agentIdArg).toBe("target");
  });

  it("prefers the target session entry for compaction runtime metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
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

    const call = requireCompactEmbeddedAgentSessionCall();
    expect(call.sessionId).toBe("target-session");
    expect(call.groupId).toBe("target-group");
    expect(call.groupChannel).toBe("#target");
    expect(call.groupSpace).toBe("target-space");
    expect(call.spawnedBy).toBe("agent:target-parent");
    expect(call.skillsSnapshot).toEqual({ prompt: "target", skills: [] });
  });

  it("carries a model-locked session's persisted native runtime into compaction", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no codex app-server thread binding",
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "locked-session",
          updatedAt: Date.now(),
          agentHarnessId: "codex",
          agentRuntimeOverride: "openclaw",
          modelSelectionLocked: true,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      sessionId: "locked-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
  });

  it("targets the persisted native CLI session for manual compaction", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
        ] as never,
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
    });

    try {
      await handleCompactCommand(
        {
          ...buildCompactParams("/compact", {
            commands: { text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig),
          provider: "anthropic",
          sessionEntry: {
            sessionId: "cli-session",
            updatedAt: Date.now(),
            cliSessionBindings: {
              "claude-cli": { sessionId: "native-claude-session" },
            },
          },
        } as HandleCommandsParams,
        true,
      );

      expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
        agentHarnessId: "claude-cli",
        cliSessionId: "native-claude-session",
        trigger: "manual",
      });
    } finally {
      cliBackendsTesting.resetDepsForTest();
    }
  });

  it.each([
    { provider: "anthropic", harness: "claude-cli", override: true, expectedRuntime: "claude-cli" },
    { provider: "anthropic", harness: "claude-cli", expectedRuntime: "claude-cli" },
    { provider: "openai", harness: "claude-cli", override: true, expectedRuntime: undefined },
    { provider: "openai", harness: "claude-cli", expectedRuntime: undefined },
    { provider: "anthropic", harness: "codex", override: true, expectedRuntime: undefined },
    { provider: "openai", harness: "codex", expectedRuntime: "codex" },
    { provider: "github-copilot", harness: "copilot", expectedRuntime: "copilot" },
  ])(
    "uses the model picker's runtime only when it serves $provider (#117470)",
    async ({ provider, harness, expectedRuntime, ...testCase }) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () =>
          [
            {
              id: "claude-cli",
              modelProvider: "anthropic",
              config: { command: "claude" },
              bundleMcp: false,
            },
            {
              id: "copilot",
              modelProvider: "github-copilot",
              config: { command: "copilot" },
              bundleMcp: false,
            },
          ] as never,
        resolvePluginSetupCliBackend: () => {
          throw new Error("manual compaction attempted synchronous CLI setup discovery");
        },
      });
      vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "runtime ownership probe",
      });

      try {
        await handleCompactCommand(
          {
            ...buildCompactParams("/compact", {
              commands: { text: true },
              channels: { whatsapp: { allowFrom: ["*"] } },
            } as OpenClawConfig),
            provider,
            sessionEntry: {
              sessionId: "picker-session",
              updatedAt: Date.now(),
              ...("override" in testCase ? { agentRuntimeOverride: harness } : {}),
              agentHarnessId: harness,
            },
          } as HandleCommandsParams,
          true,
        );

        expect(requireCompactEmbeddedAgentSessionCall().agentHarnessId).toBe(expectedRuntime);
      } finally {
        cliBackendsTesting.resetDepsForTest();
        vi.mocked(compactEmbeddedAgentSession).mockReset();
      }
    },
  );

  it("prefers the target session entry when incrementing compaction count", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
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
    expect(call.compactionKind).toBe("context-engine");
    expect(call.tokensAfter).toBe(321);
  });

  it("reports authoritative compaction no-ops without incrementing", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "target-session",
          updatedAt: Date.now(),
          totalTokens: 999,
          totalTokensFresh: true,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Compaction skipped");
  });

  it("reports server-side compaction with before and after tokens", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "server-endpoint",
      result: {
        kind: "server-endpoint",
        tokensBefore: 8_614,
        tokensAfter: 736,
      },
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: { sessionId: "server-session", updatedAt: Date.now() },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toContain("Server-side compaction (8614 → 736)");
    expect(requireIncrementCompactionCountCall().compactionKind).toBe("server-endpoint");
  });

  it.each([
    {
      owner: "native harness",
      compactionKind: "native-harness" as const,
      details: { completed: true },
    },
    {
      owner: "context engine",
      compactionKind: "context-engine" as const,
      details: undefined,
      successor: "successor-session",
    },
  ])("counts confirmed $owner compaction without a post-compaction count", async (testCase) => {
    const { details } = testCase;
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: testCase.compactionKind,
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 999,
        ...(details ? { details } : {}),
        ...("successor" in testCase ? { sessionId: testCase.successor } : {}),
      },
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "native-session",
          updatedAt: Date.now(),
          totalTokens: 999,
          totalTokensFresh: true,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(incrementCompactionCount)).toHaveBeenCalledOnce();
    expect(requireIncrementCompactionCountCall().compactionKind).toBe(testCase.compactionKind);
    expect(requireIncrementCompactionCountCall().tokensAfter).toBeUndefined();
    if ("successor" in testCase) {
      expect(requireIncrementCompactionCountCall().newSessionId).toBe("successor-session");
    }
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(null, null);
    expect(result?.reply?.text).toContain("Compaction finished (resulting context unknown) •");
    expect(result?.reply?.text).not.toContain("undefined");
  });
});
