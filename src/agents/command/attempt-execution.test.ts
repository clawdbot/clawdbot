// Covers attempt-execution helper behavior around retries, Claude CLI
// transcripts, and ACP visible text accumulation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliBackendLog } from "../cli-runner/log.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptPath,
  claudeCliSessionTranscriptHasOrphanedToolUse,
  createAcpVisibleTextAccumulator,
  formatClaudeCliFallbackPrelude,
  resolveFallbackRetryPrompt,
  sessionFileHasContent,
} from "./attempt-execution.helpers.js";
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

  it("preserves original body for fallback retry when session has no history (subagent spawn)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
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

  it("preserves original body on fallback retry without history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
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
            { type: "tool_use", name: "Bash" },
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
  it("returns empty string when no sessionId is provided", () => {
    expect(buildClaudeCliFallbackContextPrelude({ cliSessionId: undefined })).toBe("");
    expect(buildClaudeCliFallbackContextPrelude({ cliSessionId: "  " })).toBe("");
  });

  it("returns empty string when the Claude session file does not exist", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-prelude-"));
    try {
      expect(
        buildClaudeCliFallbackContextPrelude({
          cliSessionId: "missing-session",
          homeDir: tmpHome,
        }),
      ).toBe("");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("reads a real Claude JSONL fixture and emits a labeled prelude end-to-end", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-prelude-"));
    const sessionId = "e2e-session";
    const projectsDir = path.join(tmpHome, ".claude", "projects", "demo");
    try {
      // Use Claude's JSONL shape directly so parser and formatter behavior stay
      // aligned with real CLI transcripts rather than synthetic message arrays.
      await fs.mkdir(projectsDir, { recursive: true });
      const lines = [
        {
          type: "user",
          uuid: "u1",
          message: { role: "user", content: "prior question about deploys" },
        },
        {
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "prior answer about blue-green" }],
          },
        },
      ];
      await fs.writeFile(
        path.join(projectsDir, `${sessionId}.jsonl`),
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        "utf-8",
      );
      const prelude = buildClaudeCliFallbackContextPrelude({
        cliSessionId: sessionId,
        homeDir: tmpHome,
      });
      expect(prelude).toContain("## Prior session context (from claude-cli)");
      expect(prelude).toContain("user: prior question about deploys");
      expect(prelude).toContain("assistant: prior answer about blue-green");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("sessionFileHasContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false for undefined sessionFile", async () => {
    expect(await sessionFileHasContent(undefined)).toBe(false);
  });

  it("returns false when session file does not exist", async () => {
    expect(await sessionFileHasContent(path.join(tmpDir, "nonexistent.jsonl"))).toBe(false);
  });

  it("returns false when session file is empty", async () => {
    const file = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(file, "", "utf-8");
    expect(await sessionFileHasContent(file)).toBe(false);
  });

  it("returns false when session file has only user message (no assistant flush)", async () => {
    const file = path.join(tmpDir, "user-only.jsonl");
    await fs.writeFile(
      file,
      '{"type":"session","id":"s1"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );
    expect(await sessionFileHasContent(file)).toBe(false);
  });

  it("returns true when session file has assistant message (flushed)", async () => {
    const file = path.join(tmpDir, "with-assistant.jsonl");
    await fs.writeFile(
      file,
      '{"type":"session","id":"s1"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n{"type":"message","message":{"role":"assistant","content":"hi"}}\n',
      "utf-8",
    );
    expect(await sessionFileHasContent(file)).toBe(true);
  });

  it("returns true when session file has spaced JSON (role : assistant)", async () => {
    const file = path.join(tmpDir, "spaced.jsonl");
    await fs.writeFile(
      file,
      '{"type":"message","message":{"role": "assistant","content":"hi"}}\n',
      "utf-8",
    );
    expect(await sessionFileHasContent(file)).toBe(true);
  });

  it("returns true when assistant message appears after large user content", async () => {
    const file = path.join(tmpDir, "large-user.jsonl");
    // Create a user message whose JSON line exceeds 256KB to ensure the
    // JSONL-based parser (CWE-703 fix) finds the assistant record that a
    // naive byte-prefix approach would miss.
    const bigContent = "x".repeat(300 * 1024);
    const lines =
      [
        `{"type":"session","id":"s1"}`,
        `{"type":"message","message":{"role":"user","content":"${bigContent}"}}`,
        `{"type":"message","message":{"role":"assistant","content":"done"}}`,
      ].join("\n") + "\n";
    await fs.writeFile(file, lines, "utf-8");
    expect(await sessionFileHasContent(file)).toBe(true);
  });

  it("returns false when session file is a symbolic link", async () => {
    const realFile = path.join(tmpDir, "real.jsonl");
    await fs.writeFile(
      realFile,
      '{"type":"message","message":{"role":"assistant","content":"hi"}}\n',
      "utf-8",
    );
    const link = path.join(tmpDir, "link.jsonl");
    await fs.symlink(realFile, link);
    expect(await sessionFileHasContent(link)).toBe(false);
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

  it("returns false when the Claude project transcript is missing or empty", async () => {
    const workspaceDir = await makeWorkspace();
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "missing-session",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);

    await writeClaudeProjectFile(workspaceDir, "empty-session", "");
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "empty-session",
        workspaceDir,
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

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

    let graceFires = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      delay?: number,
    ) => {
      if (delay === GRACE_MS) {
        graceFires += 1;
        const flush = fs.appendFile(
          file,
          `${JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
          })}\n`,
          "utf-8",
        );
        void flush.then(() => {
          handler();
        });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      expect(
        await claudeCliSessionTranscriptHasContent({
          sessionId,
          workspaceDir,
          homeDir: tmpDir,
        }),
      ).toBe(true);
      expect(graceFires).toBe(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("returns false and emits a structured v4 warn when the JSONL never appears", async () => {
    const workspaceDir = await makeWorkspace();
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      delay?: number,
    ) => {
      if (delay === GRACE_MS) {
        handler();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

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
      setTimeoutSpy.mockRestore();
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
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      delay?: number,
    ) => {
      if (delay === GRACE_MS) {
        handler();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

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
      setTimeoutSpy.mockRestore();
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
});
