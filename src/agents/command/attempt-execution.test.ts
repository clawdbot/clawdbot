import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeCliSessionTranscriptHasContent,
  createAcpVisibleTextAccumulator,
  resolveFallbackRetryPrompt,
  sessionFileHasContent,
} from "./attempt-execution.helpers.js";

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

describe("claudeCliSessionTranscriptHasContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-claude-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeClaudeProjectFile(sessionId: string, content: string) {
    const projectDir = path.join(tmpDir, ".claude", "projects", "demo-workspace");
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, content, "utf-8");
    return file;
  }

  it("returns false when the Claude project transcript is missing or empty", async () => {
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "missing-session",
        homeDir: tmpDir,
      }),
    ).toBe(false);

    await writeClaudeProjectFile("empty-session", "");
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "empty-session",
        homeDir: tmpDir,
      }),
    ).toBe(false);
  });

  it("returns true when the Claude project transcript has an assistant message", async () => {
    await writeClaudeProjectFile(
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
        homeDir: tmpDir,
      }),
    ).toBe(true);
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", async () => {
    await writeClaudeProjectFile("safe-session", "");
    expect(
      await claudeCliSessionTranscriptHasContent({
        sessionId: "../safe-session",
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
