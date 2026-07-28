// Covers CLI session transcript loading and reseeding boundaries.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { MAX_AGENT_HOOK_HISTORY_MESSAGES } from "../harness/hook-history.js";
import { cliBackendLog } from "./log.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";

const MAX_CLI_SESSION_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
const MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS = 256 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  agentId?: string;
  filePath?: string;
  messages?: string[];
}): string {
  // Tests write the canonical session envelope first so loaders exercise the
  // same JSONL record order used by persisted OpenClaw sessions.
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

function createOversizedSessionTranscript(rootDir: string, sessionId: string): string {
  return createSessionTranscript({
    rootDir,
    sessionId,
    messages: ["x".repeat(MAX_CLI_SESSION_HISTORY_FILE_BYTES), "tail history"],
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectMessageFields(value: unknown, expected: { role: string; content?: unknown }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(expected.role);
  if ("content" in expected) {
    expect(message.content).toEqual(expected.content);
  }
}

function expectCompactionSummary(value: unknown, summary: string) {
  const message = requireRecord(value, "compaction summary");
  expect(message.role).toBe("compactionSummary");
  expect(message.summary).toBe(summary);
}

function expectCustomMessage(value: unknown, expected: { customType: string; content: string }) {
  const message = requireRecord(value, "custom message");
  expect(message.role).toBe("custom");
  expect(message.customType).toBe(expected.customType);
  expect(message.content).toBe(expected.content);
}

function expectBranchSummary(value: unknown, summary: string) {
  const message = requireRecord(value, "branch summary");
  expect(message.role).toBe("branchSummary");
  expect(message.summary).toBe(summary);
}

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

describe("loadCliSessionHistoryMessages", () => {
  it("reads the canonical session transcript instead of an arbitrary external path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
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
      await withCliSessionState(stateDir, async () => {
        // The caller-supplied path is intentionally hostile here; canonical state
        // resolution prevents a stale or external file from becoming hook input.
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-test",
          sessionFile: outsideFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "expected history" });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("detects canonical transcripts when callers pass stale external session paths", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-test",
      messages: ["expected history"],
    });
    const outsideFile = createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-test",
      filePath: path.join(outsideDir, "stale.jsonl"),
      messages: ["stale history"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        await expect(
          hasCliSessionTranscript({
            sessionId: "session-test",
            sessionFile: outsideFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).resolves.toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest bounded history window", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-bounded",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `msg-${index}`,
      ),
    });

    try {
      await withCliSessionState(stateDir, async () => {
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
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("loads only the branch selected by transcript leaf controls", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-leaf-control",
      messages: ["active root"],
    });
    fs.appendFileSync(
      sessionFile,
      [
        {
          type: "message",
          id: "side-entry",
          parentId: "msg-0",
          timestamp: new Date(2).toISOString(),
          message: { role: "assistant", content: "side delivery", timestamp: 2 },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-entry",
          timestamp: new Date(3).toISOString(),
          targetId: "msg-0",
        },
        {
          type: "message",
          id: "active-tail",
          parentId: "msg-0",
          timestamp: new Date(4).toISOString(),
          message: { role: "assistant", content: "active tail", timestamp: 4 },
        },
        {
          type: "metadata",
          id: "opaque-after-active-tail",
          parentId: "side-entry",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-leaf-control",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(2);
        expectMessageFields(history[0], { role: "user", content: "active root" });
        expectMessageFields(history[1], {
          role: "assistant",
          content: [{ type: "text", text: "active tail" }],
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps complete history for context-engine snapshots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-context-engine-history",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `msg-${index}`,
      ),
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionContextEngineMessages({
          sessionId: "session-context-engine-history",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES + 25);
        expectMessageFields(history[0], { role: "user", content: "msg-0" });
        expectMessageFields(history.at(-1), {
          role: "user",
          content: `msg-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the latest compaction summary and complete tail for context-engine snapshots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-context-engine-compacted",
      messages: ["old ask"],
    });
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "compaction",
        id: "compact-1",
        timestamp: new Date(2).toISOString(),
        summary: "Earlier compacted context",
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "custom_message",
        id: "custom-tail",
        parentId: "compaction-1",
        timestamp: new Date(3).toISOString(),
        customType: "runtime-note",
        content: "tail custom context",
        display: false,
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "branch_summary",
        id: "branch-tail",
        parentId: "custom-tail",
        fromId: "custom-tail",
        timestamp: new Date(4).toISOString(),
        summary: "tail branch context",
      })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "msg-tail",
        parentId: "branch-tail",
        timestamp: new Date(5).toISOString(),
        message: {
          role: "assistant",
          content: "tail answer",
          timestamp: 5,
        },
      })}\n`,
      "utf-8",
    );

    try {
      // Context-engine snapshots need the compacted summary plus the exact tail
      // records so downstream context reconstruction preserves branch metadata.
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionContextEngineMessages({
          sessionId: "session-context-engine-compacted",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(4);
        expectCompactionSummary(history[0], "Earlier compacted context");
        expectCustomMessage(history[1], {
          customType: "runtime-note",
          content: "tail custom context",
        });
        expectBranchSummary(history[2], "tail branch context");
        expectMessageFields(history[3], {
          role: "assistant",
          content: [{ type: "text", text: "tail answer" }],
        });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked transcripts instead of following them outside the sessions directory", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
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
      await withCliSessionState(stateDir, async () => {
        // lstat rejection is the security boundary; following the link would make
        // arbitrary filesystem content eligible for prompt/history injection.
        expect(
          await loadCliSessionHistoryMessages({
            sessionId: "session-symlink",
            sessionFile: canonicalSessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).toStrictEqual([]);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("loads a bounded tail from oversized transcript files", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createOversizedSessionTranscript(stateDir, "session-oversized");
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-oversized",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "tail history" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cli session history truncated to last"),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the opened file size when the transcript shrinks after stat", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionFile = createOversizedSessionTranscript(stateDir, "session-oversized-shrink");
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    // Report a stale size whose bounded-read offset is beyond the real EOF,
    // as when the CLI compacts the transcript between the path stat and open.
    const realFspStat = fsp.stat;
    const statSpy = vi.spyOn(fsp, "stat").mockImplementation(async (target, ...rest) => {
      if (String(target).endsWith("session-oversized-shrink.jsonl")) {
        const stats = await realFspStat(target as Parameters<typeof realFspStat>[0]);
        // Proxy keeps the Stats prototype (isFile etc.) and only inflates the
        // reported size past EOF; spreading a Stats instance would drop both.
        return new Proxy(stats, {
          get: (obj, prop, receiver) =>
            prop === "size"
              ? obj.size + MAX_CLI_SESSION_HISTORY_FILE_BYTES + 4096
              : Reflect.get(obj, prop, receiver),
        });
      }
      return realFspStat(target as Parameters<typeof realFspStat>[0], ...rest);
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-oversized-shrink",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "tail history" });
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("cli session history parse failed"),
        );
      });
    } finally {
      statSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("skips oversized transcript tails when branch controls were dropped", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-oversized-branch.jsonl",
    );
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "session-oversized-branch",
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "root", timestamp: 1 },
        }),
        JSON.stringify({
          type: "leaf",
          id: "active-leaf",
          parentId: "side-entry",
          timestamp: new Date(2).toISOString(),
          targetId: "root",
        }),
        JSON.stringify({
          type: "message",
          id: "filler",
          parentId: "root",
          timestamp: new Date(3).toISOString(),
          message: {
            role: "assistant",
            content: "x".repeat(MAX_CLI_SESSION_HISTORY_FILE_BYTES),
            timestamp: 3,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "side-entry",
          parentId: "root",
          timestamp: new Date(4).toISOString(),
          message: { role: "assistant", content: "side history", timestamp: 4 },
        }),
        JSON.stringify({
          type: "message",
          id: "active-tail",
          parentId: "root",
          timestamp: new Date(5).toISOString(),
          message: { role: "assistant", content: "active history", timestamp: 5 },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    try {
      await withCliSessionState(stateDir, async () => {
        await expect(
          loadCliSessionHistoryMessages({
            sessionId: "session-oversized-branch",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).resolves.toStrictEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cli session history truncated tail skipped"),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("warns when transcript parsing fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-invalid-jsonl.jsonl",
    );
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{not-json}\n", "utf-8");

    try {
      await withCliSessionState(stateDir, async () => {
        await expect(
          loadCliSessionHistoryMessages({
            sessionId: "session-invalid-jsonl",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).resolves.toStrictEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cli session history parse failed:"),
        );
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("honors custom session store roots when resolving hook history transcripts", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const customStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-store-"));
    const storePath = path.join(customStoreDir, "sessions.json");
    fs.writeFileSync(storePath, "{}", "utf-8");
    const sessionFile = createSessionTranscript({
      rootDir: customStoreDir,
      sessionId: "session-custom-store",
      filePath: path.join(customStoreDir, "session-custom-store.jsonl"),
      messages: ["custom store history"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
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
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(customStoreDir, { recursive: true, force: true });
    }
  });
});

describe("loadCliSessionReseedMessages", () => {
  it("does not reseed fresh CLI sessions from raw transcript history before compaction", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-no-compaction",
      messages: ["raw secret", "large context"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        expect(
          await loadCliSessionReseedMessages({
            sessionId: "session-no-compaction",
            sessionFile,
            sessionKey: "agent:main:main",
            agentId: "main",
          }),
        ).toStrictEqual([]);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds safe invalidated sessions from a bounded raw message tail when explicitly opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-opt-in-raw-tail",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `raw-${index}`,
      ),
    });

    try {
      await withCliSessionState(stateDir, async () => {
        // Raw transcript reseed is deliberately opt-in and bounded so missing CLI
        // sessions do not replay an unbounded pre-compaction transcript.
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
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("raw-reseeds consecutive ambient user rows", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-consecutive-ambient",
      messages: ["#10 Sam: first ambient", "#11 Lee: second ambient", "#12 Pat: @bot what now?"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        const reseed = await loadCliSessionReseedMessages({
          sessionId: "session-consecutive-ambient",
          sessionFile,
          sessionKey: "agent:main:main",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "missing-transcript",
        });

        expect(reseed).toHaveLength(3);
        expectMessageFields(reseed[0], { role: "user", content: "#10 Sam: first ambient" });
        expectMessageFields(reseed[1], { role: "user", content: "#11 Lee: second ambient" });
        expectMessageFields(reseed[2], { role: "user", content: "#12 Pat: @bot what now?" });
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not raw-reseed auth-boundary invalidations even when opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-auth-boundary",
      messages: ["previous account context"],
    });

    try {
      await withCliSessionState(stateDir, async () => {
        // Auth changes are a hard boundary: old raw messages may belong to a
        // different credential context and must not reseed a fresh CLI session.
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
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds fresh CLI sessions from the latest compaction summary and post-compaction tail", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
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
      await withCliSessionState(stateDir, async () => {
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
      });
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
      messages: [
        { role: "user", content: "x".repeat(100) },
        { role: "assistant", content: "y".repeat(100) },
      ],
      prompt: "current ask must survive",
      maxHistoryChars: 20,
    });

    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    expect(prompt).toContain("<next_user_message>\ncurrent ask must survive\n</next_user_message>");
    // Older 100-char prefix must be dropped by the tail slice; the
    // post-cap rendered tail is shorter than the dropped prefix.
    expect(prompt).not.toContain("x".repeat(80));
  });

  it("keeps a whole code point when the retained history tail starts inside an emoji", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [{ role: "user", content: "prefix😀tail" }],
      prompt: "next",
      maxHistoryChars: 5,
    });

    expect(prompt).toContain(
      "<conversation_history>\n[OpenClaw reseed history truncated; older turns dropped]\ntail\n</conversation_history>",
    );
  });

  it("scales automatic reseed history caps from Claude context tiers", () => {
    expect(resolveAutoCliSessionReseedHistoryChars(0)).toBe(MAX_CLI_SESSION_RESEED_HISTORY_CHARS);
    expect(resolveAutoCliSessionReseedHistoryChars(32_000)).toBe(
      MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
    expect(resolveAutoCliSessionReseedHistoryChars(200_000)).toBe(64_000);
    expect(resolveAutoCliSessionReseedHistoryChars(1_048_576)).toBe(
      MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
  });

  it("keeps the most recent turns when rendered history exceeds the cap", () => {
    // Older turns plus a final marker turn whose content is exactly what a
    // head-slice would drop first. Asserting the marker survives in the
    // rendered prompt locks in tail-slice semantics: a session-recovery
    // feature must keep the latest context, not the oldest.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "x".repeat(8000) },
        { role: "assistant", content: "y".repeat(8000) },
        { role: "user", content: "FINAL_USER_MARKER" },
        { role: "assistant", content: "FINAL_ASSISTANT_MARKER" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    expect(prompt).toContain("FINAL_USER_MARKER");
    expect(prompt).toContain("FINAL_ASSISTANT_MARKER");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The oldest 8000-char block must have been dropped — a head-slice
    // would have kept it instead of the recent tail.
    expect(prompt).not.toContain("x".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("preserves the compaction summary when the post-summary transcript exceeds the cap", () => {
    // loadCliSessionReseedMessages places a compactionSummary entry first
    // so the compacted prior context survives reseed. A blind tail slice
    // of the joined history would drop that summary whenever the
    // post-summary tail alone exceeds the cap. The structure-aware
    // truncation pins the summary as a prefix and caps only the tail.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: "COMPACTION_SUMMARY_MARKER pinned context" },
        { role: "user", content: "z".repeat(8000) },
        { role: "assistant", content: "w".repeat(8000) },
        { role: "user", content: "POST_SUMMARY_FINAL_USER" },
        { role: "assistant", content: "POST_SUMMARY_FINAL_ASSISTANT" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    // Compaction summary must be pinned as a prefix, not sliced away.
    expect(prompt).toContain("Compaction summary: COMPACTION_SUMMARY_MARKER pinned context");
    // Recent tail still preserved within the post-summary budget.
    expect(prompt).toContain("POST_SUMMARY_FINAL_USER");
    expect(prompt).toContain("POST_SUMMARY_FINAL_ASSISTANT");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Head of post-summary tail (oldest 8000-char `z` block) must be
    // dropped so the cap is honored.
    expect(prompt).not.toContain("z".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("caps oversize compaction summary while preserving recent post-summary tail", () => {
    // Two regressions covered here:
    // 1. `tailRaw.slice(-0)` would return the entire tail (JS quirk:
    //    `String.prototype.slice(-0) === slice(0)`), defeating the cap when
    //    the summary block consumes the budget.
    // 2. Pinning the full summary as-is when the summary itself exceeds
    //    `maxHistoryChars` would blow past the cap that prevents
    //    reseeding fresh CLI sessions with unexpectedly huge prompts.
    //    The summary must itself be truncated to fit the budget while still
    //    preserving the recent post-summary exact turns.
    const summaryText = "OVERSIZE_SUMMARY_MARKER ".repeat(50).trim();
    const maxHistoryChars = 200;
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_USER_DROPPED" },
        { role: "assistant", content: "POST_SUMMARY_ASSISTANT_DROPPED" },
      ],
      prompt: "next ask",
      // Cap well below the rendered summary block so the summary itself
      // must be truncated and the tail budget would naively be 0.
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    // The truncated summary still leads with recognizable load-bearing
    // text — head-slicing preserves the orientation/intro of the summary.
    expect(prompt).toContain("OVERSIZE_SUMMARY_MARKER");
    expect(prompt).toContain("Compaction summary:");
    // The leading truncation marker is present so the prompt announces
    // what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The cap is honored: the rendered <conversation_history> block
    // must not blow past `maxHistoryChars` plus a small wrapper allowance.
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // The full untruncated summary must NOT appear — that would defeat
    // the cap.
    expect(prompt).not.toContain(summaryText);
    // Post-summary exact turns are newer than the summary and must still
    // survive inside the reserved tail budget.
    expect(prompt).toContain("POST_SUMMARY_USER_DROPPED");
    expect(prompt).toContain("POST_SUMMARY_ASSISTANT_DROPPED");
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("keeps a whole code point at an oversize compaction-summary boundary", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [{ role: "compactionSummary", summary: `aa😀${"z".repeat(100)}` }],
      prompt: "next",
      maxHistoryChars: 80,
    });

    expect(prompt).toContain(
      "<conversation_history>\n[OpenClaw reseed history truncated; older turns dropped]\nCompaction summary: aa\n</conversation_history>",
    );
  });

  it("honors the cap when the summary block plus marker crosses it", () => {
    // Edge case: `summaryRendered.length < maxHistoryChars` (the gate that
    // routes to the oversize-summary branch is not taken) BUT
    // `summaryBlock.length >= maxHistoryChars` once the `\n\n` separator
    // is appended, making `remainingBudget <= 0`. Without summary
    // truncation in that branch, the rendered history block is
    // `summary + separator + marker` — well over `maxHistoryChars`. A
    // 199-char rendered summary under a 200-char cap would otherwise
    // produce a 257-char history block.
    const maxHistoryChars = 200;
    // `renderHistoryMessage` prefixes "Compaction summary: " (20 chars)
    // before the summary text, so a 179-char summary renders to 199 chars
    // — strictly less than the cap, but `summaryBlock = rendered + "\n\n"`
    // is 201 chars and `remainingBudget` is negative.
    const summaryPrefix = "Compaction summary: ";
    const summaryText = "S".repeat(maxHistoryChars - 1 - summaryPrefix.length);
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_TAIL_USER" },
        { role: "assistant", content: "POST_SUMMARY_TAIL_ASSISTANT" },
      ],
      prompt: "next ask",
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // Marker is still present so the prompt announces what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Near-cap summaries still reserve room for the newest exact turns.
    expect(prompt).toContain("POST_SUMMARY_TAIL_USER");
    expect(prompt).toContain("POST_SUMMARY_TAIL_ASSISTANT");
  });
});
