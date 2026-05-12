import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { appendSessionTranscriptMessage } from "../../config/sessions/transcript-append.js";
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
  return (await readSessionFileJsonLines<{ type?: string; message?: unknown }>(sessionFile))
    .filter((entry) => entry.type === "message")
    .map(
      (entry) =>
        entry.message as { role?: string; content?: unknown; provider?: string; model?: string },
    );
}

async function readSessionFileEntries(sessionFile: string) {
  return await readSessionFileJsonLines<{
    type?: string;
    id?: string;
    parentId?: string | null;
    cwd?: string;
    message?: { role?: string };
  }>(sessionFile);
}

async function readSessionFileJsonLines<T>(sessionFile: string): Promise<T[]> {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const entries: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    entries.push(JSON.parse(line) as T);
  }
  return entries;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  const arg = mock.mock.calls[callIndex]?.[0];
  if (arg === undefined) {
    throw new Error(`Expected mock argument for ${label}`);
  }
  return requireRecord(arg, label);
}

function expectMockArgFields(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
  callIndex = 0,
) {
  expectRecordFields(requireMockArg(mock, callIndex, "mock call argument"), fields);
}

function firstRunCliAgentArg(callIndex = 0) {
  return requireMockArg(runCliAgentMock, callIndex, "run CLI agent argument");
}

function firstEmbeddedPiAgentArg(callIndex = 0) {
  return requireMockArg(runEmbeddedPiAgentMock, callIndex, "embedded PI agent argument");
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
    expect(firstRunCliAgentArg().cliSessionId).toBe("stale-cli-session");
    expect(firstRunCliAgentArg(1).cliSessionId).toBeUndefined();
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
    expect(firstRunCliAgentArg().cliSessionId).toBeUndefined();
    expect(firstRunCliAgentArg().cliSessionBinding).toBeUndefined();
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
    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(firstRunCliAgentArg().cliSessionBinding).toEqual({
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
    expect(firstRunCliAgentArg().authProfileId).toBe("openai-codex:work");
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
      config: {},
    });

    const sessionFile = updatedEntry?.sessionFile;
    if (!sessionFile) {
      throw new Error("expected CLI transcript persistence to create a session file");
    }
    const entries = await readSessionFileEntries(sessionFile);
    expectRecordFields(requireRecord(entries[0], "session entry"), {
      type: "session",
      id: sessionEntry.sessionId,
      cwd: tmpDir,
    });
    expectRecordFields(requireRecord(entries[1], "user transcript entry"), {
      type: "message",
      parentId: null,
    });
    expectRecordFields(requireRecord(entries[2], "assistant transcript entry"), {
      type: "message",
      parentId: entries[1]?.id,
    });
    const messages = await readSessionMessages(sessionFile);
    expect(messages).toHaveLength(2);
    expectRecordFields(requireRecord(messages[0], "user message"), {
      role: "user",
      content: "persist this",
    });
    expectRecordFields(requireRecord(messages[1], "assistant message"), {
      role: "assistant",
      api: "cli",
      provider: "claude-cli",
      model: "opus",
      content: [{ type: "text", text: "hello from cli" }],
    });
  });

  it("embedded assistant gap-fill skips user mirror and dedupes identical assistant tails", async () => {
    const sessionKey = "agent:main:subagent:embedded-gap-fill";
    const sessionEntry: SessionEntry = {
      sessionId: "session-embedded-gap-fill",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const result = makeCliResult("already mirrored");
    result.meta.executionTrace = {
      winnerProvider: "anthropic",
      winnerModel: "claude-opus-4-6",
      fallbackUsed: false,
      runner: "embedded",
    };

    const updatedFirst = await persistCliTurnTranscript({
      body: "ignored for gap fill",
      transcriptBody: "also ignored",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    let messages = await readSessionMessages(updatedFirst?.sessionFile ?? "");
    expect(messages).toHaveLength(1);
    expectRecordFields(requireRecord(messages[0], "assistant message"), {
      role: "assistant",
      content: [{ type: "text", text: "already mirrored" }],
    });

    await persistCliTurnTranscript({
      body: "still ignored",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry: updatedFirst,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    messages = await readSessionMessages(updatedFirst?.sessionFile ?? "");
    expect(messages).toHaveLength(1);
  });

  it("embedded assistant gap-fill appends repeated replies after a user tail", async () => {
    const sessionKey = "agent:main:subagent:embedded-repeated-reply";
    const sessionEntry: SessionEntry = {
      sessionId: "session-embedded-repeated-reply",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const result = makeCliResult("same answer");
    result.meta.executionTrace = {
      winnerProvider: "anthropic",
      winnerModel: "claude-opus-4-6",
      fallbackUsed: false,
      runner: "embedded",
    };

    const updatedFirst = await persistCliTurnTranscript({
      body: "ignored for gap fill",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });
    const sessionFile = updatedFirst?.sessionFile;
    if (typeof sessionFile !== "string") {
      throw new Error("Expected CLI transcript session file.");
    }
    expect(path.isAbsolute(sessionFile)).toBe(true);
    expect(
      sessionFile.endsWith(
        path.join(".openclaw", "agents", "main", "sessions", `${sessionEntry.sessionId}.jsonl`),
      ),
    ).toBe(true);

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      sessionId: sessionEntry.sessionId,
      cwd: tmpDir,
      config: {},
      message: {
        role: "user",
        content: "next prompt",
        timestamp: Date.now(),
      },
    });

    await persistCliTurnTranscript({
      body: "still ignored",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry: updatedFirst,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    const messages = await readSessionMessages(sessionFile);
    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
    expectRecordFields(requireRecord(messages[2], "deduped assistant message"), {
      content: [{ type: "text", text: "same answer" }],
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
      config: {},
    });

    const messages = await readSessionMessages(updatedEntry?.sessionFile ?? "");
    expectRecordFields(requireRecord(messages[0], "transcript user message"), {
      role: "user",
      content: "visible ask",
    });
  });

  it("forwards separate user trigger, channel, and provider context to CLI runs", async () => {
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
      opts: {
        senderIsOwner: false,
        messageProvider: "discord-voice",
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
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
    expectMockArgFields(runCliAgentMock, {
      trigger: "user",
      messageChannel: "discord",
      messageProvider: "discord-voice",
    });
  });

  it("forwards runtime toolsAllow into CLI attempts so the CLI harness can fail closed", async () => {
    const sessionKey = "agent:main:direct:claude-tools-allow";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-cli-tools-allow",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("restricted cli"));

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
      runId: "run-cli-tools-allow",
      opts: {
        senderIsOwner: true,
        toolsAllow: ["read", "web_search"],
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      toolsAllow: ["read", "web_search"],
    });
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
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
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
    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      model: "claude-opus-4-7",
    });
  });

  it("routes canonical OpenAI models through the configured Codex CLI runtime", async () => {
    const sessionKey = "agent:main:direct:canonical-codex-cli";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-canonical-codex-cli",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("canonical codex cli"));

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "codex-cli" } },
            },
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
      runId: "run-canonical-codex-cli",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runCliAgentMock, {
      provider: "codex-cli",
      model: "gpt-5.4",
    });
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
      modelOverride: "claude-opus-4-7",
      originalProvider: "anthropic",
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli" },
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
        messageProvider: "discord-voice",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
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
    expectMockArgFields(runEmbeddedPiAgentMock, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      agentHarnessId: "pi",
      prompt: "raw prompt",
      messageChannel: "discord",
      messageProvider: "discord-voice",
      modelRun: true,
      promptMode: "none",
      disableTools: true,
    });
    expect(firstEmbeddedPiAgentArg().prompt).not.toContain("[Inter-session message]");
  });

  it("forwards trusted elevated defaults to embedded agent runs", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-elevated-followup",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
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
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "follow up after approved exec",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-elevated-followup",
      opts: {
        senderIsOwner: false,
        bashElevated,
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expectMockArgFields(runEmbeddedPiAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      bashElevated,
    });
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

    expectMockArgFields(runCliAgentMock, {
      cleanupBundleMcpOnRunEnd: true,
      cleanupCliLiveSessionOnRunEnd: true,
    });
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

  it("does not store a session harness pin for default OpenAI Codex routing", async () => {
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

    expectMockArgFields(runEmbeddedPiAgentMock, { agentHarnessId: undefined });
  });

  it("ignores stale session Codex harness pins on non-OpenAI model switches", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "mixed-provider-session",
      updatedAt: Date.now(),
      agentHarnessId: "codex",
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "minimax",
      originalProvider: "minimax",
      modelOverride: "minimax-m2.7",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "switch to minimax",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-mixed-provider-auto-runtime",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "minimax",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedPiAgentMock, { agentHarnessId: undefined });
  });

  it("forwards runtime toolsAllow into embedded attempts", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "tools-allow-session",
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
      body: "read only",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-tools-allow",
      opts: {
        senderIsOwner: true,
        toolsAllow: ["read", "web_search"],
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
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

    expectMockArgFields(runEmbeddedPiAgentMock, { toolsAllow: ["read", "web_search"] });
  });

  it("lets provider/model runtime policy choose Codex without storing a session harness pin", async () => {
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
        models: {
          providers: {
            codex: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
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

    expectMockArgFields(runEmbeddedPiAgentMock, { agentHarnessId: undefined });
  });

  it("auto-forwards OpenAI Codex auth profiles to default Codex harness runs", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "codex-auth-session",
      updatedAt: Date.now(),
    };
    await fs.writeFile(
      path.join(tmpDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-codex:work": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      }),
    );
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
      runId: "run-codex-auto-auth-profile",
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

    expectMockArgFields(runEmbeddedPiAgentMock, {
      agentHarnessId: undefined,
      authProfileId: "openai-codex:work",
      authProfileIdSource: "auto",
    });
  });

  it("pins a fresh OpenAI session to the Codex harness by default", async () => {
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

    expectMockArgFields(runEmbeddedPiAgentMock, { agentHarnessId: undefined });
  });

  it("ignores stale OpenAI sessions pinned to PI and relies on default Codex routing", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "stale-pi-session",
      updatedAt: Date.now(),
      agentHarnessId: "pi",
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
      runId: "run-stale-openai-pi-pin",
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

    expectMockArgFields(runEmbeddedPiAgentMock, {
      provider: "openai",
      agentHarnessId: undefined,
    });
  });

  it("routes explicit OpenAI PI runs with Codex OAuth through the legacy Codex auth transport", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "explicit-pi-codex-oauth-session",
      updatedAt: Date.now(),
      authProfileOverride: "openai-codex:work",
      authProfileOverrideSource: "user",
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "pi" },
              models: [],
            },
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
      runId: "run-openai-pi-codex-oauth",
      opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai-codex",
      sessionHasHistory: false,
    });

    expectMockArgFields(runEmbeddedPiAgentMock, {
      provider: "openai-codex",
      model: "gpt-5.4",
      agentHarnessId: undefined,
      authProfileId: "openai-codex:work",
      authProfileIdSource: "user",
    });
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
            agentRuntime: { id: "claude-cli" },
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
    expect(firstEmbeddedPiAgentArg()).not.toHaveProperty("agentHarnessId", "claude-cli");
  });
});
