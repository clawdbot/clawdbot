import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import {
  runMemoryFlushIfNeeded,
  runPreflightCompactionIfNeeded,
  setAgentRunnerMemoryTestDeps,
} from "./agent-runner-memory.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";

const compactEmbeddedPiSessionMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const incrementCompactionCountMock = vi.fn();

function createReplyOperation() {
  return {
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
  } as never;
}

describe("runMemoryFlushIfNeeded", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-unit-"));
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    compactEmbeddedPiSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    runEmbeddedPiAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    refreshQueuedFollowupSessionMock.mockReset();
    incrementCompactionCountMock.mockReset().mockImplementation(async (params) => {
      const sessionKey = String(params.sessionKey ?? "");
      if (!sessionKey || !params.sessionStore?.[sessionKey]) {
        return undefined;
      }
      const previous = params.sessionStore[sessionKey] as SessionEntry;
      const nextEntry: SessionEntry = {
        ...previous,
        compactionCount: (previous.compactionCount ?? 0) + 1,
      };
      if (typeof params.newSessionId === "string" && params.newSessionId) {
        nextEntry.sessionId = params.newSessionId;
        if (typeof params.newSessionFile === "string" && params.newSessionFile) {
          nextEntry.sessionFile = params.newSessionFile;
        } else {
          const storePath = typeof params.storePath === "string" ? params.storePath : rootDir;
          nextEntry.sessionFile = path.join(
            path.dirname(storePath),
            `${params.newSessionId}.jsonl`,
          );
        }
      }
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeTestSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
    setAgentRunnerMemoryTestDeps({
      compactEmbeddedPiSession: compactEmbeddedPiSessionMock as never,
      runWithModelFallback: runWithModelFallbackMock as never,
      runEmbeddedPiAgent: runEmbeddedPiAgentMock as never,
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      incrementCompactionCount: incrementCompactionCountMock as never,
      registerAgentRunContext: vi.fn() as never,
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(async () => {
    setAgentRunnerMemoryTestDeps();
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("runs a memory flush turn, rotates after compaction, and persists metadata", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: { phase: string } }) => void;
      }) => {
        params.onAgentEvent?.({ stream: "compaction", data: { phase: "end" } });
        return {
          payloads: [],
          meta: { agentMeta: { sessionId: "session-rotated" } },
        };
      },
    );

    const followupRun = createTestFollowupRun();
    const entry = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      followupRun,
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      transcriptPrompt?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.transcriptPrompt).toBe("");
    expect(flushCall.prompt).not.toBe(flushCall.transcriptPrompt);
    expect(flushCall.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(flushCall.silentExpected).toBe(true);
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: sessionKey,
      previousSessionId: "session",
      nextSessionId: "session-rotated",
      nextSessionFile: expect.stringContaining("session-rotated.jsonl"),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe("session-rotated");
    expect(persisted.main.compactionCount).toBe(2);
    expect(persisted.main.memoryFlushCompactionCount).toBe(2);
    expect(persisted.main.memoryFlushAt).toBe(1_700_000_000_000);
  });

  it("runs memory flush on the configured maintenance model without active fallbacks", async () => {
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      model: "ollama/qwen3:8b",
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude",
              fallbacks: ["openai/gpt-5.4"],
            },
            compaction: {
              memoryFlush: {
                model: "ollama/qwen3:8b",
              },
            },
          },
        },
      },
      followupRun: createTestFollowupRun({ provider: "anthropic", model: "claude" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(runWithModelFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        model: "qwen3:8b",
        fallbacksOverride: [],
      }),
    );
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        model: "qwen3:8b",
        authProfileId: undefined,
        authProfileIdSource: undefined,
      }),
    );
  });

  it("skips memory flush for CLI providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const entry = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { cliBackends: { "codex-cli": { command: "codex" } } } } },
      followupRun: createTestFollowupRun({ provider: "codex-cli" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "codex-cli/gpt-5.5",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("uses runtime policy session key when checking memory-flush sandbox writability", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const entry = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "non-main",
              scope: "agent",
              workspaceAccess: "ro",
            },
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionKey: "agent:main:main",
        runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      }),
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("passes runtime policy session key to preflight compaction sandbox resolution", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
        runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sandboxSessionKey: "agent:main:telegram:default:direct:12345",
      }),
    );
  });

  it("updates the active preflight run after transcript rotation", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    const successorFile = path.join(rootDir, "session-rotated.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedPiSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensAfter: 42,
        sessionId: "session-rotated",
        sessionFile: successorFile,
      },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const sessionStore = { "agent:main:main": sessionEntry };
    const followupRun = createTestFollowupRun({
      sessionId: "session",
      sessionFile,
      sessionKey: "agent:main:main",
    });
    const updateSessionId = vi.fn();
    const replyOperation = {
      abortSignal: new AbortController().signal,
      setPhase: vi.fn(),
      updateSessionId,
    } as never;

    const entry = await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation,
    });

    expect(entry?.sessionId).toBe("session-rotated");
    expect(entry?.sessionFile).toBe(successorFile);
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionFile).toBe(successorFile);
    expect(updateSessionId).toHaveBeenCalledWith("session-rotated");
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "agent:main:main",
      previousSessionId: "session",
      nextSessionId: "session-rotated",
      nextSessionFile: successorFile,
    });
  });

  it("includes recent output tokens when deciding preflight compaction", async () => {
    const sessionFile = path.join(rootDir, "session-usage.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "large answer",
          usage: { input: 90_000, output: 10_000 },
        },
      })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const compactCall = compactEmbeddedPiSessionMock.mock.calls[0]?.[0] as {
      currentTokenCount?: number;
    };
    expect(compactCall.currentTokenCount).toBeGreaterThanOrEqual(100_000);
  });

  it("uses the active run sessionFile when the session entry has no transcript path", async () => {
    const sessionFile = path.join(rootDir, "active-run-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "large answer",
          usage: { input: 90_000, output: 8_000 },
        },
      })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        sessionFile: expect.stringContaining("active-run-session.jsonl"),
      }),
    );
  });

  it("keeps preflight compaction conservative for content appended after latest usage", async () => {
    const sessionFile = path.join(rootDir, "post-usage-tail-session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: "small answer",
            usage: { input: 40_000, output: 2_000 },
          },
        }),
        JSON.stringify({
          message: {
            role: "tool",
            content: `large interrupted tool output ${"x".repeat(450_000)}`,
          },
        }),
      ].join("\n"),
      "utf8",
    );
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runPreflightCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const compactCall = compactEmbeddedPiSessionMock.mock.calls[0]?.[0] as {
      currentTokenCount?: number;
    };
    expect(compactCall.currentTokenCount).toBeGreaterThan(100_000);
  });

  it("triggers preflight compaction when the active transcript exceeds the configured byte threshold", async () => {
    const sessionFile = path.join(rootDir, "large-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(256) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    const sessionStore = { main: sessionEntry };
    const replyOperation = {
      abortSignal: new AbortController().signal,
      setPhase: vi.fn(),
      updateSessionId: vi.fn(),
    };

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: replyOperation as never,
    });

    expect(entry?.compactionCount).toBe(1);
    expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
    const compactCall = compactEmbeddedPiSessionMock.mock.calls[0]?.[0] as {
      currentTokenCount?: number;
      sessionFile?: string;
      sessionId?: string;
      trigger?: string;
    };
    expect(compactCall).toEqual(
      expect.objectContaining({
        sessionId: "session",
        trigger: "budget",
        currentTokenCount: 10,
      }),
    );
    expect(compactCall.sessionFile).toContain("large-session.jsonl");
  });

  it("keeps the active transcript byte threshold inactive unless transcript rotation is enabled", async () => {
    const sessionFile = path.join(rootDir, "large-session-no-rotation.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(256) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      compactionCount: 0,
    };

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
  });

  it("uses configured prompts and stored bootstrap warning signatures", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Write notes.\nNO_REPLY to memory/2023-11-14.md and MEMORY.md",
      systemPrompt: "Flush memory now. NO_REPLY memory/YYYY-MM-DD.md MEMORY.md",
      relativePath: "memory/2023-11-14.md",
    }));

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({ extraSystemPrompt: "extra system" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      transcriptPrompt?: string;
      extraSystemPrompt?: string;
      bootstrapPromptWarningSignaturesSeen?: string[];
      bootstrapPromptWarningSignature?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Write notes.");
    expect(flushCall.prompt).toContain("NO_REPLY");
    expect(flushCall.prompt).toContain("MEMORY.md");
    expect(flushCall.transcriptPrompt).toBe("");
    expect(flushCall.extraSystemPrompt).toContain("extra system");
    expect(flushCall.extraSystemPrompt).toContain("Flush memory now.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(flushCall.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});
