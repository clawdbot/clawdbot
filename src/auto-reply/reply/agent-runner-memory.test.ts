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
import { runMemoryFlushIfNeeded, setAgentRunnerMemoryTestDeps } from "./agent-runner-memory.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";

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
        const storePath = typeof params.storePath === "string" ? params.storePath : rootDir;
        nextEntry.sessionFile = path.join(path.dirname(storePath), `${params.newSessionId}.jsonl`);
      }
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeTestSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
    setAgentRunnerMemoryTestDeps({
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
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
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
      defaultModel: "codex-cli/gpt-5.4",
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
      extraSystemPrompt?: string;
      bootstrapPromptWarningSignaturesSeen?: string[];
      bootstrapPromptWarningSignature?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Write notes.");
    expect(flushCall.prompt).toContain("NO_REPLY");
    expect(flushCall.prompt).toContain("MEMORY.md");
    expect(flushCall.extraSystemPrompt).toContain("extra system");
    expect(flushCall.extraSystemPrompt).toContain("Flush memory now.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(flushCall.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});
