// Covers attempt-execution helper behavior around retries, Claude CLI
// transcripts, and ACP visible text accumulation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";

const mocks = vi.hoisted(() => ({
  readClaudeCliFallbackSeed: vi.fn(),
}));

vi.mock("../cli-runner/log.js", () => ({
  cliBackendLog: { warn: vi.fn() },
}));

vi.mock("../../gateway/cli-session-history.js", () => ({
  readClaudeCliFallbackSeed: mocks.readClaudeCliFallbackSeed,
}));

import { cliBackendLog } from "../cli-runner/log.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
  createAcpVisibleTextAccumulator,
  resolveFallbackRetryPrompt,
  sessionTranscriptHasContent,
} from "./attempt-execution.helpers.js";
import {
  claudeCliSessionTranscriptPath,
  formatClaudeCliFallbackPrelude,
} from "./attempt-execution.helpers.test-support.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";

describe("resolveFallbackRetryPrompt", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";

  it("returns original body on first attempt (isFallbackRetry=false)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
      }),
    ).toBe(originalBody);
  });

  it("prepends recovery prefix to original body on fallback retry with existing session history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: true,
      }),
    ).toBe(`[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`);
  });

  it("preserves original body for fallback retry when sessionHasHistory is undefined", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
      }),
    ).toBe(originalBody);
  });

  it("returns original body on first attempt regardless of sessionHasHistory", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: true,
      }),
    ).toBe(originalBody);

    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("prepends priorContextPrelude before the retry marker on fallback retry", () => {
    const prelude = "## Prior session context (from claude-cli)\nuser: prior question";
    // Claude fallback prelude must come before the retry marker so the model
    // receives prior CLI context before the instruction about failure recovery.
    const result = resolveFallbackRetryPrompt({
      body: originalBody,
      isFallbackRetry: true,
      sessionHasHistory: true,
      priorContextPrelude: prelude,
    });
    expect(result).toBe(
      `${prelude}\n\n[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`,
    );
  });

  it("emits the retry prompt with prelude even when sessionHasHistory is false (claude-cli case)", () => {
    const prelude = "## Prior session context (from claude-cli)\nuser: prior question";
    const result = resolveFallbackRetryPrompt({
      body: originalBody,
      isFallbackRetry: true,
      sessionHasHistory: false,
      priorContextPrelude: prelude,
    });
    expect(result).toBe(
      `${prelude}\n\n[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`,
    );
  });

  it("ignores empty/whitespace priorContextPrelude", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
        priorContextPrelude: "   \n  ",
      }),
    ).toBe(originalBody);
  });

  it("does not prepend prelude on non-fallback first attempts", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: true,
        priorContextPrelude: "anything",
      }),
    ).toBe(originalBody);
  });
});

describe("formatClaudeCliFallbackPrelude", () => {
  it("returns empty string when seed has neither summary nor turns", () => {
    expect(formatClaudeCliFallbackPrelude({ recentTurns: [] })).toBe("");
  });

  it("emits summary alone when no turns are available", () => {
    const out = formatClaudeCliFallbackPrelude({
      summaryText: "User wants to ship a billing-aware fallback.",
      recentTurns: [],
    });
    expect(out).toContain("## Prior session context (from claude-cli)");
    expect(out).toContain("Summary of earlier conversation:");
    expect(out).toContain("User wants to ship a billing-aware fallback.");
    expect(out).not.toContain("Recent turns:");
  });

  it("formats user/assistant turns and tags tool blocks with compact hints", () => {
    // Tool-use blocks are represented as compact hints because fallback prompts
    // should preserve intent without replaying full tool schemas or outputs.
    const out = formatClaudeCliFallbackPrelude({
      recentTurns: [
        {
          role: "user",
          content: "Earlier user question",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Earlier assistant reply" },
            { type: "toolcall", name: "Bash" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              content: "Earlier tool output",
            },
          ],
        },
      ],
    });
    expect(out).toContain("## Prior session context (from claude-cli)");
    expect(out).toContain("Recent turns:");
    expect(out).toContain("user: Earlier user question");
    expect(out).toContain("assistant: Earlier assistant reply");
    expect(out).toContain("(tool call: Bash)");
    expect(out).toContain("(tool result: Earlier tool output)");
  });

  it("truncates an oversized summary instead of dropping it silently", () => {
    const huge = "x ".repeat(10_000).trim();
    const out = formatClaudeCliFallbackPrelude(
      { summaryText: huge, recentTurns: [] },
      { charBudget: 600 },
    );
    expect(out).toContain("Summary of earlier conversation (truncated):");
    expect(out.length).toBeLessThan(800);
    expect(out).toMatch(/…$/);
  });

  it.each([
    ["a surrogate boundary", `${"x".repeat(21)}😀${"y".repeat(100)}`, "x".repeat(21)],
    ["the ASCII budget", "x".repeat(100), "x".repeat(22)],
  ])("preserves %s when truncating an oversized summary", (_label, summaryText, expected) => {
    const out = formatClaudeCliFallbackPrelude(
      { summaryText, recentTurns: [] },
      { charBudget: 128 },
    );

    expect(out).toContain(`Summary of earlier conversation (truncated):\n${expected} …`);
  });

  it("drops oldest turns first when the budget cannot fit all of them", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i + 1} ${"x".repeat(80)}`,
    }));
    const out = formatClaudeCliFallbackPrelude({ recentTurns: turns }, { charBudget: 350 });
    // Newest turn must be present; oldest turns are the first budget casualty.
    expect(out).toContain("turn 10");
    expect(out).not.toContain("turn 1 ");
  });

  it("keeps the recent turn window contiguous when an adjacent turn is oversized", () => {
    const out = formatClaudeCliFallbackPrelude(
      {
        recentTurns: [
          { role: "user", content: "older small turn" },
          { role: "assistant", content: `oversized adjacent turn ${"x".repeat(500)}` },
          { role: "user", content: "newest small turn" },
        ],
      },
      { charBudget: 260 },
    );

    expect(out).toContain("newest small turn");
    expect(out).not.toContain("oversized adjacent turn");
    expect(out).not.toContain("older small turn");
  });
});

describe("buildClaudeCliFallbackContextPrelude", () => {
  beforeEach(() => {
    mocks.readClaudeCliFallbackSeed.mockReset();
  });

  it("returns empty string when no sessionId is provided", () => {
    expect(buildClaudeCliFallbackContextPrelude({ cliSessionId: undefined })).toBe("");
    expect(buildClaudeCliFallbackContextPrelude({ cliSessionId: "  " })).toBe("");
    expect(mocks.readClaudeCliFallbackSeed).not.toHaveBeenCalled();
  });

  it("returns empty string when the Claude session loader finds no seed", () => {
    mocks.readClaudeCliFallbackSeed.mockReturnValue(undefined);

    expect(
      buildClaudeCliFallbackContextPrelude({
        cliSessionId: "missing-session",
        homeDir: "/tmp/test-home",
      }),
    ).toBe("");
    expect(mocks.readClaudeCliFallbackSeed).toHaveBeenCalledWith({
      cliSessionId: "missing-session",
      homeDir: "/tmp/test-home",
    });
  });

  it("formats the Claude session loader seed into a labeled fallback prelude", () => {
    mocks.readClaudeCliFallbackSeed.mockReturnValue({
      recentTurns: [
        {
          role: "user",
          content: "prior question about deploys",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "prior answer about blue-green" },
            { type: "toolcall", name: "Bash" },
          ],
        },
      ],
    });

    const prelude = buildClaudeCliFallbackContextPrelude({
      cliSessionId: " e2e-session ",
      homeDir: "/tmp/test-home",
    });
    expect(mocks.readClaudeCliFallbackSeed).toHaveBeenCalledWith({
      cliSessionId: "e2e-session",
      homeDir: "/tmp/test-home",
    });
    expect(prelude).toContain("## Prior session context (from claude-cli)");
    expect(prelude).toContain("user: prior question about deploys");
    expect(prelude).toContain("assistant: prior answer about blue-green");
    expect(prelude).toContain("(tool call: Bash)");
  });
});

describe("sessionTranscriptHasContent", () => {
  let tmpDir: string;
  let target: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oc-transcript-probe-")));
    target = {
      agentId: "audit",
      sessionId: "fallback-history",
      sessionKey: "agent:audit:main",
      storePath: path.join(tmpDir, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  });

  afterEach(async () => {
    await waitForSessionTranscriptIndexReconcile({
      agentId: target.agentId,
      path: target.storePath,
    });
    closeOpenClawAgentDatabaseByPath(target.storePath);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const assistantMessage = () =>
    buildAssistantMessage({
      model: { api: "test", provider: "test", id: "test-assistant-model" },
      content: [{ type: "text", text: "persisted answer" }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
      timestamp: 2,
    });

  it("marks fallback history only after SQLite contains an assistant turn", async () => {
    expect(await sessionTranscriptHasContent(undefined)).toBe(false);
    expect(await sessionTranscriptHasContent(target)).toBe(false);
    const manager = SessionManager.open(target, tmpDir);
    manager.appendMessage({ role: "user", content: "x".repeat(300 * 1024), timestamp: 1 });
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(false);
    manager.appendMessage(assistantMessage());
    manager.flushPendingPersistence();

    const sessionHasHistory = await sessionTranscriptHasContent(target);
    expect(sessionHasHistory).toBe(true);
    expect(
      resolveFallbackRetryPrompt({ body: "continue", isFallbackRetry: true, sessionHasHistory }),
    ).toBe("[Retry after the previous model attempt failed or timed out]\n\ncontinue");
  });

  it("ignores abandoned assistants and clears history at reset boundaries", async () => {
    const manager = SessionManager.open(target, tmpDir);
    const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    manager.appendMessage(assistantMessage());
    manager.branch(root);
    manager.appendMessage({ role: "user", content: "active branch", timestamp: 3 });
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(false);

    manager.appendMessage(assistantMessage());
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(true);
    manager.appendResetBoundary("new");
    manager.appendMessage({ role: "user", content: "fresh turn", timestamp: 4 });
    manager.flushPendingPersistence();
    expect(await sessionTranscriptHasContent(target)).toBe(false);
  });
});

describe("claudeCliSessionTranscriptPath", () => {
  it("returns null for malformed session ids", () => {
    expect(
      claudeCliSessionTranscriptPath({
        sessionId: "../escape",
        workspaceDir: "/tmp/ws",
        homeDir: "/home/x",
      }),
    ).toBeNull();
    expect(
      claudeCliSessionTranscriptPath({
        sessionId: "",
        workspaceDir: "/tmp/ws",
        homeDir: "/home/x",
      }),
    ).toBeNull();
  });

  it("returns null when workspaceDir is empty or whitespace", () => {
    expect(
      claudeCliSessionTranscriptPath({
        sessionId: "abc",
        workspaceDir: "",
        homeDir: "/home/x",
      }),
    ).toBeNull();
    expect(
      claudeCliSessionTranscriptPath({
        sessionId: "abc",
        workspaceDir: "   ",
        homeDir: "/home/x",
      }),
    ).toBeNull();
  });

  it("uses the canonical Claude project dir resolver", () => {
    expect(
      claudeCliSessionTranscriptPath({
        sessionId: "11111111-2222-3333-4444-555555555555",
        workspaceDir: "/home/faris/.openclaw/workspace",
        homeDir: "/home/faris",
      }),
    ).toBe(
      path.join(
        "/home/faris",
        ".claude",
        "projects",
        "-home-faris--openclaw-workspace",
        "11111111-2222-3333-4444-555555555555.jsonl",
      ),
    );
    expect(
      claudeCliSessionTranscriptPath({
        sessionId: "session-x",
        workspaceDir: "/tmp/foo_bar.baz",
        homeDir: "/home/x",
      }),
    ).toBe(path.join("/home/x", ".claude", "projects", "-tmp-foo-bar-baz", "session-x.jsonl"));
  });

  it("canonicalizes symlinked workspaces before resolving the Claude project dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-claude-project-link-"));
    try {
      const workspaceDir = path.join(root, "workspace");
      const linkDir = path.join(root, "workspace-link");
      await fs.mkdir(workspaceDir);
      await fs.symlink(workspaceDir, linkDir, "dir");

      expect(
        claudeCliSessionTranscriptPath({
          sessionId: "session-link",
          workspaceDir: linkDir,
          homeDir: root,
        }),
      ).toBe(
        path.join(
          resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir: root }),
          "session-link.jsonl",
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("claudeCliSessionTranscriptHasContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-claude-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeWorkspace() {
    const workspaceDir = await fs.mkdtemp(path.join(tmpDir, "ws-"));
    return workspaceDir;
  }

  async function writeClaudeProjectFile(workspaceDir: string, sessionId: string, content: string) {
    const projectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir, homeDir: tmpDir });
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, content, "utf-8");
    return file;
  }

  const GRACE_MS = 250;

  it("returns true when the Claude project transcript has an assistant message", async () => {
    const workspaceDir = await makeWorkspace();
    await writeClaudeProjectFile(
      workspaceDir,
      "session-with-assistant",
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      })}\n`,
    );

    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "session-with-assistant",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", async () => {
    const workspaceDir = await makeWorkspace();
    await writeClaudeProjectFile(workspaceDir, "safe-session", "");
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "../safe-session",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns false when workspaceDir is missing (path cannot be computed)", async () => {
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "any-session",
        workspaceDir: undefined,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns true immediately when the assistant message is already flushed (no grace sleep)", async () => {
    const workspaceDir = await makeWorkspace();
    await writeClaudeProjectFile(
      workspaceDir,
      "already-flushed",
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
      })}\n`,
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      expect(
        await claudeCliSessionTranscriptHasContent({
          sessionId: "already-flushed",
          workspaceDir,
          homeDir: tmpDir,
        }),
      ).toBe(true);
      const graceCalls = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === GRACE_MS);
      expect(graceCalls).toHaveLength(0);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("returns true on the second scan when the assistant message lands during the grace window", async () => {
    const workspaceDir = await makeWorkspace();
    const sessionId = "fs-flush-latency";
    const file = await writeClaudeProjectFile(
      workspaceDir,
      sessionId,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      })}\n`,
    );

    const graceStarted = createDeferred();
    const releaseGrace = createDeferred();
    const schedule = globalThis.setTimeout;
    let graceFires = 0;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler, delay, ...args) => {
        if (delay !== GRACE_MS) {
          return schedule(handler, delay, ...args);
        }
        // Hold only this probe's grace sleep; worker completion must retain native timers.
        setTimeoutSpy.mockRestore();
        graceFires += 1;
        graceStarted.resolve();
        return schedule(() => {
          void releaseGrace.promise.then(() => handler(...args));
        }, delay);
      });
    const probe = claudeCliSessionTranscriptHasContent({
      sessionId,
      workspaceDir,
      homeDir: tmpDir,
    });
    try {
      await Promise.race([graceStarted.promise, probe]);
      expect(graceFires).toBe(1);
      await fs.appendFile(
        file,
        `${JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
        })}\n`,
        "utf-8",
      );
      releaseGrace.resolve();
      expect(await probe).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      releaseGrace.resolve();
      await probe;
    }
  });

  it("returns false and emits a structured v4 warn when the JSONL never appears", async () => {
    const workspaceDir = await makeWorkspace();
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    try {
      expect(
        await claudeCliSessionTranscriptHasContent({
          sessionId: "ghost-session",
          workspaceDir,
          homeDir: tmpDir,
        }),
      ).toBe(false);
      const v4Warnings = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.startsWith("claude-cli transcript probe v4 miss"),
      );
      expect(v4Warnings).toHaveLength(1);
      const message = v4Warnings[0]?.[0];
      expect(message).toContain("sessionId=ghost-session");
      expect(message).toContain(`grace ${GRACE_MS}ms`);
      expect(message).toContain("fileExists=false");
      expect(message).toContain(
        `expectedPath=${claudeCliSessionTranscriptPath({
          sessionId: "ghost-session",
          workspaceDir,
          homeDir: tmpDir,
        })}`,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns false and emits a v4 warn flagging fileExists=true when the JSONL stays headerless", async () => {
    const workspaceDir = await makeWorkspace();
    const sessionId = "user-header-only";
    await writeClaudeProjectFile(
      workspaceDir,
      sessionId,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      })}\n`,
    );

    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    try {
      expect(
        await claudeCliSessionTranscriptHasContent({
          sessionId,
          workspaceDir,
          homeDir: tmpDir,
        }),
      ).toBe(false);
      const v4Warnings = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.startsWith("claude-cli transcript probe v4 miss"),
      );
      expect(v4Warnings).toHaveLength(1);
      expect(v4Warnings[0]?.[0]).toContain("fileExists=true");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("claudeCliSessionTranscriptHasOrphanedToolUse", () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-claude-orphan-test-"));
    workspaceDir = await fs.mkdtemp(path.join(tmpDir, "ws-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeJsonlSession(sessionId: string, lines: object[]) {
    const projectDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir,
      homeDir: tmpDir,
    });
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    return file;
  }

  it("returns false when the transcript is missing", async () => {
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "no-such-session",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns false when the last assistant message has no tool_use", async () => {
    await writeJsonlSession("text-only", [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "all done" }] },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "text-only",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns false when every tool_use in the last assistant message has a matching tool_result", async () => {
    await writeJsonlSession("answered", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "answered",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns true when the last assistant message has a trailing tool_use without tool_result", async () => {
    await writeJsonlSession("orphan", [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "let me run that" }] },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_unanswered", name: "Bash", input: {} }],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "orphan",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("returns true when a Claude server tool use is unanswered", async () => {
    await writeJsonlSession("server-tool-orphan", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_unanswered", name: "web_search", input: {} },
          ],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "server-tool-orphan",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("returns false when Claude-specific tool uses have matching tool results", async () => {
    await writeJsonlSession("claude-specific-answered", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
            { type: "mcp_tool_use", id: "mcptoolu_1", name: "mcp__demo", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
            { type: "mcp_tool_result", tool_use_id: "mcptoolu_1", content: "ok" },
          ],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "claude-specific-answered",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns false when Claude hosted tool results are in the assistant message", async () => {
    await writeJsonlSession("assistant-hosted-tool-result", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_inline", name: "web_search", input: {} },
            { type: "web_search_tool_result", tool_use_id: "srvtoolu_inline", content: [] },
            { type: "text", text: "found it" },
          ],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "assistant-hosted-tool-result",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns true when the last assistant has multiple tool_use and at least one is orphaned", async () => {
    await writeJsonlSession("partial", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "Bash", input: {} },
            { type: "tool_use", id: "toolu_b", name: "Read", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "partial",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("returns false when an earlier assistant tool_use is unanswered but the last assistant message resolved cleanly", async () => {
    await writeJsonlSession("buried", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_old", name: "Bash", input: {} }],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "moving on" }] },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "buried",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns false when a later string assistant message supersedes an old orphan", async () => {
    await writeJsonlSession("buried-string", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_old_string", name: "Bash", input: {} }],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: "moving on" },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "buried-string",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", async () => {
    await writeJsonlSession("safe", []);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "../safe",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("ignores sidechain entries when deciding orphans (matches main-history importer's skip rule)", async () => {
    await writeJsonlSession("sidechain-trailing", [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      {
        isSidechain: true,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_subagent", name: "Bash", input: {} }],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "sidechain-trailing",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("still flags a main-conversation orphan even when sidechain entries exist alongside", async () => {
    await writeJsonlSession("main-orphan-with-sidechain", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_main_orphan", name: "Bash", input: {} }],
        },
      },
      {
        isSidechain: true,
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_main_orphan", content: "ignored sidechain" },
          ],
        },
      },
    ]);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "main-orphan-with-sidechain",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("inspects the transcript tail past 500 records (does not inherit the content-probe cap)", async () => {
    const lines: object[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `ping ${i}` }] },
      });
    }
    lines.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_resolved_late", name: "Bash", input: {} }],
      },
    });
    lines.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_resolved_late", content: "ok" }],
      },
    });
    lines.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_trailing_orphan", name: "Bash", input: {} }],
      },
    });
    await writeJsonlSession("long-with-trailing-orphan", lines);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "long-with-trailing-orphan",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("does not falsely flag a long transcript whose orphan was resolved past record 500", async () => {
    const lines: object[] = [];
    lines.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_resolved_far_later", name: "Bash", input: {} }],
      },
    });
    for (let i = 0; i < 600; i++) {
      lines.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `ping ${i}` }] },
      });
    }
    lines.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_resolved_far_later", content: "ok" }],
      },
    });
    lines.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "moving on" }] },
    });
    await writeJsonlSession("long-with-resolved-far-later", lines);
    expect(
      await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: "long-with-resolved-far-later",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });
});

describe("createAcpVisibleTextAccumulator", () => {
  it("preserves cumulative raw snapshots after stripping a glued NO_REPLY prefix", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLYThe user")).toEqual({
      text: "The user",
      delta: "The user",
    });

    expect(acc.consume("NO_REPLYThe user is saying")).toEqual({
      text: "The user is saying",
      delta: " is saying",
    });

    expect(acc.finalize()).toBe("The user is saying");
    expect(acc.finalizeRaw()).toBe("The user is saying");
  });

  it("keeps append-only deltas working after stripping a glued NO_REPLY prefix", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLYThe user")).toEqual({
      text: "The user",
      delta: "The user",
    });

    expect(acc.consume(" is saying")).toEqual({
      text: "The user is saying",
      delta: " is saying",
    });
  });

  it("preserves punctuation-start text that begins with NO_REPLY-like content", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLY: explanation")).toEqual({
      text: "NO_REPLY: explanation",
      delta: "NO_REPLY: explanation",
    });

    expect(acc.finalize()).toBe("NO_REPLY: explanation");
    expect(acc.finalizeReplySnapshot()).toEqual({
      disposition: "visible",
      text: "NO_REPLY: explanation",
    });
  });

  it("buffers chunked NO_REPLY prefixes before emitting visible text", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO")).toBeNull();
    expect(acc.consume("NO_")).toBeNull();
    expect(acc.consume("NO_RE")).toBeNull();
    expect(acc.consume("NO_REPLY")).toBeNull();
    expect(acc.consume("Actual answer")).toEqual({
      text: "Actual answer",
      delta: "Actual answer",
    });
  });

  it.each([
    {
      name: "visible output",
      chunks: ["Final answer"],
      expected: { disposition: "visible", text: "Final answer" },
    },
    { name: "exact silence", chunks: ["NO_REPLY"], expected: { disposition: "silent" } },
    { name: "clean empty output", chunks: [], expected: { disposition: "empty" } },
    { name: "partial control prefix", chunks: ["NO_RE"], expected: { disposition: "empty" } },
    {
      name: "punctuation-wrapped silence",
      chunks: ["NO_REPLY:"],
      expected: { disposition: "silent" },
    },
    {
      name: "ellipsis-wrapped silence",
      chunks: ["NO_REPLY..."],
      expected: { disposition: "silent" },
    },
    {
      name: "chunked punctuation-wrapped silence",
      chunks: ["NO_REPLY", ":"],
      expected: { disposition: "silent" },
    },
    {
      name: "glued visible continuation",
      chunks: ["NO_REPLYVisible continuation"],
      expected: { disposition: "visible", text: "Visible continuation" },
    },
  ])("classifies $name at ACP finalization", ({ chunks, expected }) => {
    const acc = createAcpVisibleTextAccumulator();
    for (const chunk of chunks) {
      acc.consume(chunk);
    }
    expect(acc.finalizeReplySnapshot()).toEqual(expected);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
