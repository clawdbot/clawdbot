import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCliSessionHistoryPrompt,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  MAX_CLI_SESSION_HISTORY_FILE_BYTES,
  MAX_CLI_SESSION_HISTORY_MESSAGES,
} from "./session-history.js";

function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  agentId?: string;
  filePath?: string;
  messages?: string[];
}): string {
  const sessionFile =
    params.filePath ??
    path.join(
      params.rootDir,
      "agents",
      params.agentId ?? "main",
      "sessions",
      `${params.sessionId}.jsonl`,
    );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: params.rootDir,
    })}\n`,
    "utf-8",
  );
  for (const [index, message] of (params.messages ?? []).entries()) {
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: `msg-${index}`,
        parentId: index > 0 ? `msg-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message: {
          role: "user",
          content: message,
          timestamp: index + 1,
        },
      })}\n`,
      "utf-8",
    );
  }
  return sessionFile;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectMessageFields(value: unknown, expected: { role: string; content?: string }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(expected.role);
  if ("content" in expected) {
    expect(message.content).toBe(expected.content);
  }
}

function expectCompactionSummary(value: unknown, summary: string) {
  const message = requireRecord(value, "compaction summary");
  expect(message.role).toBe("compactionSummary");
  expect(message.summary).toBe(summary);
}

describe("loadCliSessionHistoryMessages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the canonical session transcript instead of an arbitrary external path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-test",
      messages: ["expected history"],
    });
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-test",
      filePath: path.join(outsideDir, "stolen.jsonl"),
      messages: ["stolen history"],
    });

    try {
      const history = await loadCliSessionHistoryMessages({
        sessionId: "session-test",
        sessionFile: outsideFile,
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      expect(history).toHaveLength(1);
      expectMessageFields(history[0], { role: "user", content: "expected history" });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest bounded history window", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-bounded",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `msg-${index}`,
      ),
    });

    try {
      const history = await loadCliSessionHistoryMessages({
        sessionId: "session-bounded",
        sessionFile,
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      expect(history).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
      expectMessageFields(history[0], { role: "user", content: "msg-25" });
      expectMessageFields(history.at(-1), {
        role: "user",
        content: `msg-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked transcripts instead of following them outside the sessions directory", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const canonicalSessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-symlink.jsonl",
    );
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-symlink",
      filePath: path.join(outsideDir, "outside.jsonl"),
      messages: ["stolen history"],
    });
    fs.mkdirSync(path.dirname(canonicalSessionFile), { recursive: true });
    fs.symlinkSync(outsideFile, canonicalSessionFile);

    try {
      expect(
        await loadCliSessionHistoryMessages({
          sessionId: "session-symlink",
          sessionFile: canonicalSessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toStrictEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("drops oversized transcript files instead of loading them into hook payloads", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-oversized.jsonl",
    );
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "x".repeat(MAX_CLI_SESSION_HISTORY_FILE_BYTES + 1), "utf-8");

    try {
      expect(
        await loadCliSessionHistoryMessages({
          sessionId: "session-oversized",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toStrictEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("honors custom session store roots when resolving hook history transcripts", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const customStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-store-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(customStoreDir, "sessions.json");
    fs.writeFileSync(storePath, "{}", "utf-8");
    const sessionFile = createSessionTranscript({
      rootDir: customStoreDir,
      sessionId: "session-custom-store",
      filePath: path.join(customStoreDir, "session-custom-store.jsonl"),
      messages: ["custom store history"],
    });

    try {
      const history = await loadCliSessionHistoryMessages({
        sessionId: "session-custom-store",
        sessionFile,
        sessionKey: "agent:main:main",
        agentId: "main",
        config: {
          session: {
            store: storePath,
          },
        },
      });
      expect(history).toHaveLength(1);
      expectMessageFields(history[0], { role: "user", content: "custom store history" });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(customStoreDir, { recursive: true, force: true });
    }
  });
});

describe("loadCliSessionReseedMessages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not reseed fresh CLI sessions from raw transcript history before compaction", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-no-compaction",
      messages: ["raw secret", "large context"],
    });

    try {
      expect(
        await loadCliSessionReseedMessages({
          sessionId: "session-no-compaction",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toStrictEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds safe invalidated sessions from a bounded raw message tail when explicitly opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-opt-in-raw-tail",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `raw-${index}`,
      ),
    });

    try {
      const reseed = await loadCliSessionReseedMessages({
        sessionId: "session-opt-in-raw-tail",
        sessionFile,
        sessionKey: "agent:main:main",
        agentId: "main",
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: "missing-transcript",
      });
      expect(reseed).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
      expectMessageFields(reseed[0], { role: "user", content: "raw-25" });
      expectMessageFields(reseed.at(-1), {
        role: "user",
        content: `raw-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
      });
      expect(buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" })).toContain(
        "raw-25",
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not raw-reseed auth-boundary invalidations even when opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-auth-boundary",
      messages: ["previous account context"],
    });

    try {
      await expect(
        loadCliSessionReseedMessages({
          sessionId: "session-auth-boundary",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "auth-profile",
        }),
      ).resolves.toStrictEqual([]);
      await expect(
        loadCliSessionReseedMessages({
          sessionId: "session-auth-boundary",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "auth-epoch",
        }),
      ).resolves.toStrictEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds fresh CLI sessions from the latest compaction summary and post-compaction tail", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-compacted",
      messages: ["pre-compaction raw history"],
    });
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "compaction",
        id: "compaction-1",
        parentId: "msg-0",
        timestamp: new Date(2).toISOString(),
        summary: "safe compacted summary",
        firstKeptEntryId: "msg-0",
        tokensBefore: 10_000,
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: "compaction-1",
        timestamp: new Date(3).toISOString(),
        message: {
          role: "user",
          content: "post-compaction ask",
          timestamp: 3,
        },
      })}\n`,
      "utf-8",
    );

    try {
      const reseed = await loadCliSessionReseedMessages({
        sessionId: "session-compacted",
        sessionFile,
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      expect(reseed).toHaveLength(2);
      expectCompactionSummary(reseed[0], "safe compacted summary");
      expectMessageFields(reseed[1], { role: "user", content: "post-compaction ask" });
      expect(buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" })).toContain(
        "Compaction summary: safe compacted summary",
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("buildCliSessionHistoryPrompt", () => {
  it("renders OpenClaw transcript history around the next user message", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "old ask" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
      prompt: "new ask",
    });

    expect(prompt).toContain("User: old ask");
    expect(prompt).toContain("Assistant: old answer");
    expect(prompt).toContain("<next_user_message>\nnew ask\n</next_user_message>");
  });

  it("skips reseed text when the transcript has no renderable conversation", () => {
    expect(
      buildCliSessionHistoryPrompt({
        messages: [{ role: "tool", content: "ignored" }],
        prompt: "new ask",
      }),
    ).toBeUndefined();
  });

  it("caps rendered reseed history before adding the next user message", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [{ role: "compactionSummary", summary: "x".repeat(100) }],
      prompt: "current ask must survive",
      maxHistoryChars: 20,
    });

    expect(prompt).toContain("[OpenClaw reseed history truncated]");
    expect(prompt).toContain("<next_user_message>\ncurrent ask must survive\n</next_user_message>");
    expect(prompt).not.toContain("x".repeat(80));
  });
});
