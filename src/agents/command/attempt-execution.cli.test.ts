import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FailoverError } from "../failover-error.js";
import { runEmbeddedPiAgent, type EmbeddedPiRunResult } from "../pi-embedded.js";
import { persistCliTurnTranscript, runAgentAttempt } from "./attempt-execution.js";

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());
const ORIGINAL_HOME = process.env.HOME;

vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string) =>
    provider.trim().toLowerCase() === "claude-cli" || provider.trim().toLowerCase() === "codex-cli",
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) =>
    provider.trim().toLowerCase() === "codex-cli" ? "openai-codex" : provider.trim().toLowerCase(),
}));

vi.mock("../pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

function makeCliResult(text: string): EmbeddedPiRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: "session-cli",
        provider: "claude-cli",
        model: "opus",
        usage: {
          input: 12,
          output: 4,
          cacheRead: 3,
          cacheWrite: 0,
          total: 19,
        },
      },
      executionTrace: {
        winnerProvider: "claude-cli",
        winnerModel: "opus",
        fallbackUsed: false,
        runner: "cli",
      },
    },
  };
}

async function readSessionMessages(sessionFile: string) {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: unknown })
    .filter((entry) => entry.type === "message")
    .map(
      (entry) =>
        entry.message as { role?: string; content?: unknown; provider?: string; model?: string },
    );
}

describe("CLI attempt execution", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-attempt-"));
    storePath = path.join(tmpDir, "sessions.json");
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
  });

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runClaudeCliAttempt(params: {
    sessionKey: string;
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    body: string;
    runId: string;
  }) {
    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionEntry.sessionId,
      sessionKey: params.sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: params.body,
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: params.runId,
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore: params.sessionStore,
      storePath,
      sessionHasHistory: false,
    });
  }

  it("clears stale Claude CLI session IDs before retrying after session expiration", async () => {
    const sessionKey = "agent:main:subagent:cli-expired";
    const homeDir = path.join(tmpDir, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    process.env.HOME = homeDir;
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, "stale-cli-session.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      })}\n`,
      "utf-8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-123",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "stale-cli-session" },
      claudeCliSessionId: "stale-legacy-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    runCliAgentMock
      .mockRejectedValueOnce(
        new FailoverError("session expired", {
          reason: "session_expired",
          provider: "claude-cli",
          model: "opus",
          status: 410,
        }),
      )
      .mockResolvedValueOnce(makeCliResult("hello from cli"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "retry this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-expired",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionId).toBe("stale-cli-session");
    expect(runCliAgentMock.mock.calls[1]?.[0]?.cliSessionId).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("does not pass --resume when the stored Claude CLI transcript is missing", async () => {
    const sessionKey = "agent:main:direct:claude-missing-transcript";
    const homeDir = path.join(tmpDir, "home");
    process.env.HOME = homeDir;
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-123",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "phantom-claude-session",
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": "phantom-claude-session" },
      claudeCliSessionId: "phantom-claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("fresh cli response"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "remember me",
      runId: "run-cli-missing-transcript",
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionId).toBeUndefined();
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionBinding).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("keeps Claude CLI resume when the stored transcript has assistant content", async () => {
    const sessionKey = "agent:main:direct:claude-transcript-present";
    const cliSessionId = "existing-claude-session";
    const homeDir = path.join(tmpDir, "home");
    const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    process.env.HOME = homeDir;
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${cliSessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "previous reply" }],
        },
      })}\n`,
      "utf-8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-456",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: cliSessionId,
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": cliSessionId },
      claudeCliSessionId: cliSessionId,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("resumed cli response"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "continue",
      runId: "run-cli-transcript-present",
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionId).toBe(cliSessionId);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.cliSessionBinding).toEqual({
      sessionId: cliSessionId,
      authProfileId: "anthropic:claude-cli",
    });
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe(cliSessionId);
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe(cliSessionId);
  });

  it("passes session-bound OpenAI Codex auth profile to codex-cli aliases", async () => {
    const sessionKey = "agent:main:direct:codex-cli-auth-alias";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-codex",
      updatedAt: Date.now(),
      authProfileOverride: "openai-codex:work",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("codex cli response"));

    await runAgentAttempt({
      providerOverride: "codex-cli",
      originalProvider: "codex-cli",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-codex-cli-auth-alias",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai-codex",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.authProfileId).toBe("openai-codex:work");
  });

  it("persists CLI replies into the session transcript", async () => {
    const sessionKey = "agent:main:subagent:cli-transcript";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-transcript",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const updatedEntry = await persistCliTurnTranscript({
      body: "persist this",
      result: makeCliResult("hello from cli"),
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
    });

    const sessionFile = updatedEntry?.sessionFile;
    expect(sessionFile).toBeTruthy();
    const messages = await readSessionMessages(sessionFile!);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "persist this",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      api: "cli",
      provider: "claude-cli",
      model: "opus",
      content: [{ type: "text", text: "hello from cli" }],
    });
  });

  it("persists the transcript body instead of runtime-only CLI prompt context", async () => {
    const sessionKey = "agent:main:subagent:cli-transcript-clean";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-transcript-clean",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const updatedEntry = await persistCliTurnTranscript({
      body: [
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "secret runtime context",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        "",
        "visible ask",
      ].join("\n"),
      transcriptBody: "visible ask",
      result: makeCliResult("hello from cli"),
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
    });

    const messages = await readSessionMessages(updatedEntry?.sessionFile ?? "");
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "visible ask",
    });
  });

  it("forwards user trigger and channel context to CLI runs", async () => {
    const sessionKey = "agent:main:direct:claude-channel-context";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-channel",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("channel aware"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-channel-context",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "user",
        messageChannel: "telegram",
        messageProvider: "telegram",
      }),
    );
  });

  it("routes canonical Anthropic models through the configured Claude CLI runtime", async () => {
    const sessionKey = "agent:main:direct:canonical-claude-cli";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-canonical-cli",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("canonical cli"));

    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli", fallback: "none" },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-canonical-claude-cli",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-opus-4-7",
      }),
    );
  });

  it("keeps one-shot model runs on the raw embedded provider path", async () => {
    const sessionKey = "agent:main:direct:model-run-raw";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-model-run-raw",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli", fallback: "none" },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "raw prompt",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-model-run-raw",
      opts: {
        senderIsOwner: false,
        modelRun: true,
        promptMode: "none",
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: true,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-7",
        agentHarnessId: "pi",
        modelRun: true,
        promptMode: "none",
        disableTools: true,
      }),
    );
  });

  it("forwards one-shot CLI cleanup to CLI providers", async () => {
    const sessionKey = "agent:main:direct:cleanup-claude-cli";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-cleanup-cli",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("cleanup cli"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "claude-opus-4-7",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "cleanup",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cleanup-claude-cli",
      opts: {
        senderIsOwner: false,
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});

describe("embedded attempt harness pinning", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-attempt-"));
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("treats legacy sessions with history as PI-pinned", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-legacy-pi-pin",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: true,
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "pi",
      }),
    );
  });

  it("pins sessions with history to the configured Codex harness instead of PI", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "codex-history-session",
      updatedAt: Date.now(),
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "codex",
      originalProvider: "codex",
      modelOverride: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "codex", fallback: "none" },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-codex-no-pi-pin",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "codex",
      sessionHasHistory: true,
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "codex",
      }),
    );
  });

  it("pins a fresh unpinned session to the default PI harness", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "fresh-session",
      updatedAt: Date.now(),
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "start",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-fresh-no-pin",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: false,
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "pi",
      }),
    );
  });

  it("does not pass CLI runtime aliases as embedded harness ids for fallback providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "fallback-session",
      updatedAt: Date.now(),
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "claude-cli",
      modelOverride: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli", fallback: "none" },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "fallback",
      isFallbackRetry: true,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-openai-fallback-with-cli-runtime",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "agentHarnessId",
      "claude-cli",
    );
  });
});
