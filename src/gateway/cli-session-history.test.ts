import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  augmentChatHistoryWithCliSessionImports,
  mergeImportedChatHistoryMessages,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.js";

const ORIGINAL_HOME = process.env.HOME;

function createClaudeHistoryLines(sessionId: string) {
  return [
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-03-26T16:29:54.722Z",
      sessionId,
      content: "[Thu 2026-03-26 16:29 GMT] Reply with exactly: AGENT CLI OK.",
    }),
    JSON.stringify({
      type: "user",
      uuid: "user-1",
      timestamp: "2026-03-26T16:29:54.800Z",
      message: {
        role: "user",
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-03-26T16:29:55.500Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello from Claude" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 22,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-03-26T16:29:56.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "Bash",
            input: {
              command: "pwd",
            },
          },
        ],
        stop_reason: "tool_use",
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "user-2",
      timestamp: "2026-03-26T16:29:56.400Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: "/tmp/demo",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "last-prompt",
      sessionId,
      lastPrompt: "ignored",
    }),
  ].join("\n");
}

async function withClaudeProjectsDir<T>(
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeHistoryLines(sessionId), "utf-8");
  process.env.HOME = homeDir;
  try {
    return await run({ homeDir, sessionId, filePath });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("cli session history", () => {
  afterEach(() => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  it("reads claude-cli session messages from the Claude projects store", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      expect(resolveClaudeCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(filePath);
      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("[Thu 2026-03-26 16:29 GMT] hi"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-1",
          cliSessionId: sessionId,
        },
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
        usage: {
          input: 11,
          output: 7,
          cacheRead: 22,
        },
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-1",
          cliSessionId: sessionId,
        },
      });
      expect(messages[2]).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "toolcall",
            id: "toolu_123",
            name: "Bash",
            arguments: {
              command: "pwd",
            },
          },
          {
            type: "tool_result",
            name: "Bash",
            content: "/tmp/demo",
            tool_use_id: "toolu_123",
          },
        ],
      });
    });
  });

  it("deduplicates imported messages against similar local transcript entries", () => {
    const localMessages = [
      {
        role: "user",
        content: "hi",
        timestamp: Date.parse("2026-03-26T16:29:54.900Z"),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from Claude" }],
        timestamp: Date.parse("2026-03-26T16:29:55.700Z"),
      },
    ];
    const importedMessages = [
      {
        role: "user",
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
        timestamp: Date.parse("2026-03-26T16:29:54.800Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-1",
          cliSessionId: "session-1",
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from Claude" }],
        timestamp: Date.parse("2026-03-26T16:29:55.500Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-1",
          cliSessionId: "session-1",
        },
      },
      {
        role: "user",
        content: "[Thu 2026-03-26 16:31 GMT] follow-up",
        timestamp: Date.parse("2026-03-26T16:31:00.000Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-2",
          cliSessionId: "session-1",
        },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({
      role: "user",
      __openclaw: {
        importedFrom: "claude-cli",
        externalId: "user-2",
      },
    });
  });

  it("augments chat history when a session has a claude-cli binding", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
            },
          },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("augments anthropic-routed chat history when a Claude CLI binding has local messages", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
            },
          },
        },
        provider: "anthropic",
        localMessages: [
          {
            role: "assistant",
            content: "local assistant turn",
            timestamp: Date.parse("2026-03-26T16:29:57.000Z"),
          },
        ],
        homeDir,
      });

      expect(messages).toHaveLength(4);
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: "local assistant turn",
        }),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          __openclaw: expect.objectContaining({ cliSessionId: sessionId }),
        }),
      );
    });
  });

  it("does not import stale Claude CLI history for unrelated providers with local messages", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const localMessages = [
        {
          role: "assistant",
          content: "local OpenAI turn",
          timestamp: Date.parse("2026-03-26T16:29:57.000Z"),
        },
      ];
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
            },
          },
        },
        provider: "openai",
        localMessages,
        homeDir,
      });

      expect(messages).toBe(localMessages);
    });
  });

  it("falls back to legacy cliSessionIds when bindings are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionIds: {
            "claude-cli": sessionId,
          },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[1]).toMatchObject({
        role: "assistant",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("falls back to legacy claudeCliSessionId when newer fields are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          claudeCliSessionId: sessionId,
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });
});

describe("readClaudeCliFallbackSeed", () => {
  let tmpRoot: string;
  let homeDir: string;
  let projectsDir: string;
  const SESSION_ID = "fallback-seed-session";

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-seed-"));
    homeDir = path.join(tmpRoot, "home");
    projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    await fs.mkdir(projectsDir, { recursive: true });
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeJsonl(lines: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    const file = path.join(projectsDir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  }

  it("returns undefined when the Claude session file does not exist", () => {
    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeUndefined();
  });

  it("collects user/assistant turns when the session has never been compacted", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "first user prompt" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "first assistant reply" }],
        },
      },
      {
        type: "user",
        uuid: "u-2",
        message: { role: "user", content: "second user prompt" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeDefined();
    expect(seed?.summaryText).toBeUndefined();
    expect(seed?.recentTurns).toHaveLength(3);
    expect(seed?.recentTurns[0]).toMatchObject({ role: "user" });
    expect(seed?.recentTurns[2]).toMatchObject({ role: "user" });
  });

  it("uses the explicit /compact summary and drops pre-boundary turns", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-pre",
        message: { role: "user", content: "pre-compact user turn excluded from seed" },
      },
      {
        type: "assistant",
        uuid: "a-pre",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "PRE-COMPACT assistant turn" }],
        },
      },
      {
        type: "summary",
        summary: "User asked about deployment; agent recommended a blue-green strategy.",
        leafUuid: "a-pre",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 12345 },
      },
      {
        type: "user",
        uuid: "u-post",
        message: { role: "user", content: "POST-COMPACT user follow-up" },
      },
      {
        type: "assistant",
        uuid: "a-post",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "POST-COMPACT assistant reply" }],
        },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeDefined();
    expect(seed?.summaryText).toBe(
      "User asked about deployment; agent recommended a blue-green strategy.",
    );
    expect(seed?.recentTurns).toHaveLength(2);
    const recentText = JSON.stringify(seed?.recentTurns);
    expect(recentText).toContain("POST-COMPACT user follow-up");
    expect(recentText).toContain("POST-COMPACT assistant reply");
    expect(recentText).not.toContain("PRE-COMPACT");
  });

  it("falls back to compact_boundary content when no explicit summary entry is present", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-pre",
        message: { role: "user", content: "early turn" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens: 50000 },
      },
      {
        type: "user",
        uuid: "u-post",
        message: { role: "user", content: "post-boundary user turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeDefined();
    // Falls back to the boundary's content so the seed at least labels
    // that compaction happened, instead of replaying nothing.
    expect(seed?.summaryText).toBe("Conversation compacted");
    expect(seed?.recentTurns).toHaveLength(1);
    expect(JSON.stringify(seed?.recentTurns)).toContain("post-boundary user turn");
  });

  it("prefers the most recent summary when the session has been compacted multiple times", async () => {
    await writeJsonl([
      {
        type: "summary",
        summary: "EARLY summary that should be superseded.",
        leafUuid: "x",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
      },
      {
        type: "user",
        uuid: "u-mid",
        message: { role: "user", content: "mid-window turn" },
      },
      {
        type: "summary",
        summary: "LATER summary that must win.",
        leafUuid: "y",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 2000 },
      },
      {
        type: "user",
        uuid: "u-tail",
        message: { role: "user", content: "tail turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed?.summaryText).toBe("LATER summary that must win.");
    expect(seed?.recentTurns).toHaveLength(1);
    expect(JSON.stringify(seed?.recentTurns)).toContain("tail turn");
    expect(JSON.stringify(seed?.recentTurns)).not.toContain("mid-window turn");
  });

  it("returns undefined when the session file is empty or has no usable content", async () => {
    await writeJsonl([
      // Sidechain entries are filtered out by the underlying parser.
      {
        type: "user",
        uuid: "u-side",
        isSidechain: true,
        message: { role: "user", content: "sidechain user turn" },
      },
    ]);
    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeUndefined();
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", () => {
    const seed = readClaudeCliFallbackSeed({ cliSessionId: "../escape" });
    expect(seed).toBeUndefined();
  });

  it("falls back to the latest boundary content when a newer compaction has no summary", async () => {
    await writeJsonl([
      { type: "summary", summary: "FIRST compact summary", leafUuid: "x" },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted (1)",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
      },
      {
        type: "user",
        uuid: "u-mid",
        message: { role: "user", content: "post-first-compact turn" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted (2)",
        compactMetadata: { trigger: "auto", preTokens: 2000 },
      },
      {
        type: "user",
        uuid: "u-tail",
        message: { role: "user", content: "post-second-compact turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeDefined();
    expect(seed?.summaryText).toBe("Conversation compacted (2)");
    expect(seed?.summaryText).not.toBe("FIRST compact summary");
    expect(seed?.recentTurns).toHaveLength(1);
    expect(JSON.stringify(seed?.recentTurns)).toContain("post-second-compact turn");
  });

  it("uses a trailing summary that has no following compact_boundary marker", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "earlier turn" },
      },
      { type: "summary", summary: "trailing summary without boundary", leafUuid: "x" },
      {
        type: "user",
        uuid: "u-2",
        message: { role: "user", content: "later turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed?.summaryText).toBe("trailing summary without boundary");
  });
});
