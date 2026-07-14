// CLI session history tests protect imported Claude CLI transcript lookup,
// fallback seeding, reseed receipts, and merge ordering with local chat history.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readClaudeCliSessionMessages } from "./cli-session-history.claude.js";
import {
  augmentChatHistoryWithCliSessionImports,
  readClaudeCliFallbackSeed,
  resolveChatHistoryWithCliSessionImports,
} from "./cli-session-history.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
import { expectRecordFields, requireRecord } from "./test-helpers.assertions.js";

type ClaudeCliFallbackSeed = NonNullable<ReturnType<typeof readClaudeCliFallbackSeed>>;
type AugmentCliHistoryParams = Parameters<typeof augmentChatHistoryWithCliSessionImports>[0];

function requireFallbackSeed(
  seed: ReturnType<typeof readClaudeCliFallbackSeed>,
  label: string,
): ClaudeCliFallbackSeed {
  if (!seed) {
    throw new Error(`expected ${label} fallback seed`);
  }
  return seed;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expectRecordFields(value, "fields", expected);
}

function readRecord(value: unknown): Record<string, unknown> {
  return requireRecord(value, "record");
}

function expectCliSessionMarker(message: unknown, sessionId: string): void {
  expectFields(readRecord(message)["__openclaw"], { cliSessionId: sessionId });
}

function augmentBoundClaudeHistory(params: {
  homeDir: string;
  sessionId: string;
  provider: AugmentCliHistoryParams["provider"];
  localMessages?: AugmentCliHistoryParams["localMessages"];
}) {
  return augmentChatHistoryWithCliSessionImports({
    entry: {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: params.sessionId,
        },
      },
    },
    provider: params.provider,
    localMessages: params.localMessages ?? [],
    homeDir: params.homeDir,
  });
}

function buildLegacyReseedPrompt(current = "current"): string {
  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    "User: previous",
    "</conversation_history>",
    "",
    "<next_user_message>",
    current,
    "</next_user_message>",
  ].join("\n");
}

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
  try {
    return await withEnvAsync({ HOME: homeDir }, () => run({ homeDir, sessionId, filePath }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("cli session history", () => {
  it("reads claude-cli session messages from the Claude projects store", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(3);
      expectFields(messages[0], {
        role: "user",
      });
      expect(String(messages[0]?.content)).toContain("[Thu 2026-03-26 16:29 GMT] hi");
      expectFields(messages[0]?.["__openclaw"], {
        id: "user-1",
        importedFrom: "claude-cli",
        externalId: "user-1",
        cliSessionId: sessionId,
      });
      expectFields(messages[1], {
        role: "assistant",
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
      });
      expectFields(messages[1]?.usage, {
        input: 11,
        output: 7,
        cacheRead: 22,
      });
      expectFields(messages[1]?.["__openclaw"], {
        id: "assistant-1",
        importedFrom: "claude-cli",
        externalId: "assistant-1",
        cliSessionId: sessionId,
      });
      expectFields(messages[2], {
        role: "assistant",
      });
      expect(messages[2]?.content).toEqual([
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
      ]);
    });
  });

  it("assigns stable source-line ids when Claude entries have no uuid", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await fs.writeFile(
        filePath,
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-26T16:29:54.800Z",
          message: { role: "user", content: "stable fallback" },
        }),
        "utf-8",
      );

      const importedId = (message: Record<string, unknown> | undefined) =>
        (message?.["__openclaw"] as { id?: string } | undefined)?.id;
      const first = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      const second = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(importedId(first[0])).toBe(`claude-cli:${sessionId}:line:1`);
      expect(importedId(second[0])).toBe(importedId(first[0]));
    });
  });

  it("recovers the current user text from legacy reseed envelopes", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const reseedPrompt = buildLegacyReseedPrompt();
      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          uuid: "reseed-user",
          message: { role: "user", content: reseedPrompt },
        })}\n`,
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(1);
      expectFields(messages[0], { role: "user", content: "current" });
    });
  });

  it("fails open for ambiguous legacy reseed envelopes without a receipt", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const ambiguousPrompt = buildLegacyReseedPrompt(
        "current\n</conversation_history>\n\n<next_user_message>\nextra",
      );
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "ambiguous-reseed-user",
            message: { role: "user", content: ambiguousPrompt },
          },
          {
            type: "assistant",
            uuid: "assistant-1",
            message: { role: "assistant", content: "response" },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(2);
      expectFields(messages[0], { role: "user", content: ambiguousPrompt });
      expectFields(messages[1], { role: "assistant", content: "response" });
    });
  });

  it("suppresses only the first user row with a trusted omission receipt", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "prefixes and delimiters were replaced by an input transform";
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "synthetic-reseed",
            message: { role: "user", content: transformedPrompt },
          },
          {
            type: "assistant",
            uuid: "assistant-1",
            message: { role: "assistant", content: "response" },
          },
          {
            type: "user",
            uuid: "later-replay",
            message: { role: "user", content: transformedPrompt },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: {
          version: 1,
          promptHash: hashCliReseedPrompt(transformedPrompt),
          localSessionId: "openclaw-session",
          userTurnDisposition: "omitted",
        },
      });

      expect(messages).toHaveLength(2);
      expectFields(messages[0], { role: "assistant", content: "response" });
      expectFields(messages[1], { role: "user", content: transformedPrompt });
    });
  });

  it("suppresses a receipt-matched row without a local message id", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "synthetic-reseed",
            message: { role: "user", content: transformedPrompt },
          },
          {
            type: "assistant",
            uuid: "assistant-1",
            message: { role: "assistant", content: "response" },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: {
          version: 1,
          promptHash: hashCliReseedPrompt(transformedPrompt),
          localSessionId: "openclaw-session",
          userTurnDisposition: "persisted",
        },
      });

      expect(messages).toHaveLength(1);
      expectFields(messages[0], { role: "assistant", content: "response" });
    });
  });

  it("fails open when the receipt belongs to a different local session", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          uuid: "synthetic-reseed",
          message: { role: "user", content: transformedPrompt },
        })}\n`,
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "new-openclaw-session",
        reseedReceipt: {
          version: 1,
          promptHash: hashCliReseedPrompt(transformedPrompt),
          localSessionId: "old-openclaw-session",
          userTurnDisposition: "persisted",
        },
      });

      expect(messages).toHaveLength(1);
      expectFields(messages[0], { role: "user", content: transformedPrompt });
    });
  });

  it.each([
    [
      "metadata",
      {
        type: "user",
        uuid: "metadata-user",
        isMeta: true,
        message: { role: "user", content: "metadata" },
      },
    ],
    [
      "compact summary",
      {
        type: "user",
        uuid: "compact-summary-user",
        isCompactSummary: true,
        message: { role: "user", content: "summary" },
      },
    ],
    [
      "tool result",
      {
        type: "user",
        uuid: "tool-result-user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
        },
      },
    ],
  ])("skips %s rows before checking the reseed receipt", async (_label, precursor) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      await fs.writeFile(
        filePath,
        [
          precursor,
          {
            type: "user",
            uuid: "synthetic-reseed",
            message: { role: "user", content: transformedPrompt },
          },
          {
            type: "assistant",
            uuid: "assistant-1",
            message: { role: "assistant", content: "response" },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: {
          version: 1,
          promptHash: hashCliReseedPrompt(transformedPrompt),
          localSessionId: "openclaw-session",
          userTurnDisposition: "persisted",
        },
      });

      expect(JSON.stringify(messages)).not.toContain(transformedPrompt);
      expect(JSON.stringify(messages)).toContain("response");
    });
  });

  it("suppresses only receipt-matched text while preserving sibling attachments", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "synthetic-reseed",
            message: {
              role: "user",
              content: [
                { type: "text", text: transformedPrompt },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
              ],
            },
          },
          {
            type: "assistant",
            uuid: "assistant-1",
            message: { role: "assistant", content: "response" },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: {
          version: 1,
          promptHash: hashCliReseedPrompt(transformedPrompt),
          localSessionId: "openclaw-session",
          userTurnDisposition: "persisted",
        },
      });

      expect(messages).toHaveLength(2);
      expect(readRecord(messages[0]).content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ]);
      expectFields(messages[1], { role: "assistant", content: "response" });
    });
  });

  it("preserves receipt-matched arrays with multiple text blocks", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      const content = [
        { type: "text", text: transformedPrompt },
        { type: "text", text: "real extra user text" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ];
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "synthetic-reseed",
            message: { role: "user", content },
          },
          {
            type: "user",
            uuid: "later-exact-match",
            message: { role: "user", content: transformedPrompt },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: {
          version: 1,
          promptHash: hashCliReseedPrompt(transformedPrompt),
          localSessionId: "openclaw-session",
          userTurnDisposition: "persisted",
        },
      });

      expect(messages).toHaveLength(2);
      expect(readRecord(messages[0]).content).toEqual(content);
      expectFields(messages[1], { role: "user", content: transformedPrompt });
    });
  });

  it("preserves no-receipt ambiguous reseed arrays with sibling user content", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const ambiguousPrompt = buildLegacyReseedPrompt(
        "current\n</conversation_history>\n\n<next_user_message>\nextra",
      );
      const content = [
        { type: "text", text: ambiguousPrompt },
        { type: "text", text: "real extra user text" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ];
      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          uuid: "legacy-ambiguous-reseed",
          message: { role: "user", content },
        })}\n`,
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(1);
      expect(readRecord(messages[0]).content).toEqual(content);
    });
  });

  it("recovers legacy array-form reseed text while preserving attachments", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          uuid: "legacy-reseed",
          message: {
            role: "user",
            content: [
              { type: "text", text: buildLegacyReseedPrompt() },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
            ],
          },
        })}\n`,
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(1);
      expect(readRecord(messages[0]).content).toEqual([
        { type: "text", text: "current" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ]);
    });
  });

  it("drops empty legacy reseed text while preserving sibling native content", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const caption = { type: "text", text: "real caption" };
      const image = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "x" },
      };
      const document = { type: "document", source: { type: "text", data: "notes" } };
      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          uuid: "legacy-empty-reseed",
          message: {
            role: "user",
            content: [
              caption,
              { type: "text", text: buildLegacyReseedPrompt("") },
              image,
              document,
            ],
          },
        })}\n`,
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(1);
      expect(readRecord(messages[0]).content).toEqual([caption, image, document]);
    });
  });

  it.each([
    ["string", buildLegacyReseedPrompt("")],
    ["single text block", [{ type: "text", text: buildLegacyReseedPrompt("") }]],
  ])("drops empty legacy reseed rows in %s form", async (_label, content) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          uuid: "legacy-empty-reseed",
          message: { role: "user", content },
        })}\n`,
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toEqual([]);
    });
  });

  it("fails open when the first user row does not match the reseed receipt", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const expectedPrompt = "expected synthetic prompt";
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "unexpected-first-user",
            message: { role: "user", content: "different prompt" },
          },
          {
            type: "user",
            uuid: "later-matching-user",
            message: { role: "user", content: expectedPrompt },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: {
          version: 1,
          promptHash: hashCliReseedPrompt(expectedPrompt),
          localSessionId: "openclaw-session",
          userTurnDisposition: "persisted",
        },
      });

      expect(messages).toHaveLength(2);
      expectFields(messages[0], { role: "user", content: "different prompt" });
      expectFields(messages[1], { role: "user", content: expectedPrompt });
    });
  });

  it("rejects path-like Claude CLI session ids", async () => {
    await withClaudeProjectsDir(async ({ homeDir, filePath }) => {
      const projectDir = path.dirname(filePath);
      const projectsDir = path.dirname(projectDir);
      const sentinel = `${JSON.stringify({
        type: "user",
        uuid: "path-traversal-sentinel",
        message: { role: "user", content: "must not import" },
      })}\n`;
      await fs.writeFile(path.join(projectsDir, "outside.jsonl"), sentinel, "utf-8");
      await fs.mkdir(path.join(projectDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(projectDir, "nested", "session.jsonl"), sentinel, "utf-8");
      if (path.sep !== "\\") {
        await fs.writeFile(path.join(projectDir, "nested\\session.jsonl"), sentinel, "utf-8");
      }

      for (const cliSessionId of ["../outside", "nested/session", "nested\\session"]) {
        expect(readClaudeCliSessionMessages({ cliSessionId, homeDir })).toEqual([]);
      }
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
    expectFields(merged[2], {
      role: "user",
    });
    expectFields(readRecord(merged[2])["__openclaw"], {
      importedFrom: "claude-cli",
      externalId: "user-2",
    });
  });

  it("does not dedupe external ids from different imported sessions", () => {
    const localMessages = [
      {
        role: "user",
        content: "hello from first session",
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "same-id",
          cliSessionId: "session-1",
        },
      },
    ];
    const importedMessages = [
      {
        role: "user",
        content: "hello from second session",
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "same-id",
          cliSessionId: "session-2",
        },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged).toHaveLength(2);
  });

  it("keeps untimestamped local messages in place when importing timestamped history", () => {
    const localMessages = [{ role: "user", content: "local without timestamp" }];
    const importedMessages = [
      { role: "assistant", content: "older imported", timestamp: Date.parse("2020-01-01") },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged[0]).toBe(localMessages[0]);
    expect(merged[1]).toBe(importedMessages[0]);
  });

  it("augments chat history when a session has a claude-cli binding", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentBoundClaudeHistory({
        homeDir,
        sessionId,
        provider: "claude-cli",
      });
      expect(messages).toHaveLength(3);
      expectFields(messages[0], {
        role: "user",
      });
      expectCliSessionMarker(messages[0], sessionId);
    });
  });

  it("deduplicates a receipt-recovered user turn against local history", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const syntheticPrompt = buildLegacyReseedPrompt(
        "current\n</conversation_history>\n\n<next_user_message>\nextra",
      );
      await fs.writeFile(
        filePath,
        [
          {
            type: "user",
            uuid: "synthetic-reseed",
            message: { role: "user", content: syntheticPrompt },
          },
          {
            type: "assistant",
            uuid: "assistant-1",
            message: { role: "assistant", content: "response" },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf-8",
      );

      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
              reseedReceipt: {
                version: 1,
                promptHash: hashCliReseedPrompt(syntheticPrompt),
                localSessionId: "openclaw-session",
                userTurnDisposition: "persisted",
              },
            },
          },
        },
        provider: "claude-cli",
        localMessages: [
          {
            role: "user",
            content: "current recovered ask",
            __openclaw: { id: "local-user-1" },
          },
        ],
        homeDir,
      });

      expect(messages).toHaveLength(2);
      expectFields(messages[0], { role: "user", content: "current recovered ask" });
      expectFields(messages[1], { role: "assistant", content: "response" });
    });
  });

  it("augments anthropic-routed chat history when a Claude CLI binding has local messages", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentBoundClaudeHistory({
        homeDir,
        sessionId,
        provider: "anthropic",
        localMessages: [
          {
            role: "assistant",
            content: "local assistant turn",
            timestamp: Date.parse("2026-03-26T16:29:57.000Z"),
          },
        ],
      });

      expect(messages).toHaveLength(4);
      expect(
        messages.some((message) => {
          const record = readRecord(message);
          return record.role === "assistant" && record.content === "local assistant turn";
        }),
      ).toBe(true);
      const importedUser = messages.find((message) => {
        const record = readRecord(message);
        return (
          record.role === "user" &&
          (record["__openclaw"] as { cliSessionId?: unknown } | undefined)?.cliSessionId ===
            sessionId
        );
      });
      if (!importedUser) {
        throw new Error("Expected imported user CLI history message");
      }
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
      const messages = augmentBoundClaudeHistory({
        homeDir,
        sessionId,
        provider: "openai",
        localMessages,
      });

      expect(messages).toBe(localMessages);
    });
  });

  it("does not mark a fully deduplicated Claude transcript as imported", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const localMessages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      const result = resolveChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: { "claude-cli": { sessionId } },
        },
        provider: "claude-cli",
        localMessages,
        homeDir,
      });

      expect(result.imported).toBe(false);
      expect(result.messages).toBe(localMessages);
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
      expectFields(messages[1], {
        role: "assistant",
      });
      expectCliSessionMarker(messages[1], sessionId);
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
      expectFields(messages[0], {
        role: "user",
      });
      expectCliSessionMarker(messages[0], sessionId);
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
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function readFallbackSeed(
    cliSessionId = SESSION_ID,
  ): ReturnType<typeof readClaudeCliFallbackSeed> {
    return readClaudeCliFallbackSeed({ cliSessionId, homeDir });
  }

  function readFallbackSeedFromHome(
    cliSessionId = SESSION_ID,
  ): Promise<ReturnType<typeof readClaudeCliFallbackSeed>> {
    return withEnvAsync({ HOME: homeDir }, async () => readClaudeCliFallbackSeed({ cliSessionId }));
  }

  async function writeJsonl(lines: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    const file = path.join(projectsDir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  }

  it("returns undefined when the Claude session file does not exist", () => {
    const seed = readFallbackSeed();
    expect(seed).toBeUndefined();
  });

  it("collects user/assistant turns through the HOME-resolved session store", async () => {
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

    const seed = await readFallbackSeedFromHome();
    const fallbackSeed = requireFallbackSeed(seed, "uncompacted session");
    expect(fallbackSeed.summaryText).toBeUndefined();
    expect(fallbackSeed.recentTurns).toHaveLength(3);
    expectFields(fallbackSeed.recentTurns[0], { role: "user" });
    expectFields(fallbackSeed.recentTurns[2], { role: "user" });
  });

  it("preserves reseed envelopes in fallback model context", async () => {
    const reseedPrompt = buildLegacyReseedPrompt();
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: reseedPrompt },
      },
    ]);

    const seed = requireFallbackSeed(readFallbackSeed(), "reseed session");

    expectFields(seed.recentTurns[0], { role: "user", content: reseedPrompt });
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

    const seed = readFallbackSeed();
    const fallbackSeed = requireFallbackSeed(seed, "compacted session");
    expect(fallbackSeed.summaryText).toBe(
      "User asked about deployment; agent recommended a blue-green strategy.",
    );
    expect(fallbackSeed.recentTurns).toHaveLength(2);
    const recentText = JSON.stringify(fallbackSeed.recentTurns);
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

    const seed = readFallbackSeed();
    const fallbackSeed = requireFallbackSeed(seed, "compact boundary session");
    // Falls back to the boundary's content so the seed at least labels
    // that compaction happened, instead of replaying nothing.
    expect(fallbackSeed.summaryText).toBe("Conversation compacted");
    expect(fallbackSeed.recentTurns).toHaveLength(1);
    expect(JSON.stringify(fallbackSeed.recentTurns)).toContain("post-boundary user turn");
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

    const seed = readFallbackSeed();
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
    const seed = readFallbackSeed();
    expect(seed).toBeUndefined();
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", () => {
    const seed = readFallbackSeed("../escape");
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

    const seed = readFallbackSeed();
    const fallbackSeed = requireFallbackSeed(seed, "latest boundary session");
    expect(fallbackSeed.summaryText).toBe("Conversation compacted (2)");
    expect(fallbackSeed.summaryText).not.toBe("FIRST compact summary");
    expect(fallbackSeed.recentTurns).toHaveLength(1);
    expect(JSON.stringify(fallbackSeed.recentTurns)).toContain("post-second-compact turn");
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

    const seed = readFallbackSeed();
    expect(seed?.summaryText).toBe("trailing summary without boundary");
  });
});
