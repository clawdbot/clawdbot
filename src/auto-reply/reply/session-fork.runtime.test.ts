import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  forkSessionFromParentRuntime,
  resolveParentForkTokenCountRuntime,
} from "./session-fork.runtime.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveParentForkTokenCountRuntime", () => {
  it("falls back to recent transcript usage when cached totals are stale", async () => {
    const root = await makeRoot("openclaw-parent-fork-token-estimate-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-overflow-transcript";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }),
    ];
    for (let index = 0; index < 40; index += 1) {
      const body = `turn-${index} ${"x".repeat(200)}`;
      lines.push(
        JSON.stringify({
          type: "message",
          id: `u${index}`,
          parentId: index === 0 ? null : `a${index - 1}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: body },
        }),
        JSON.stringify({
          type: "message",
          id: `a${index}`,
          parentId: `u${index}`,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: body,
            usage: index === 39 ? { input: 90_000, output: 20_000 } : undefined,
          },
        }),
      );
    }
    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 1,
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBe(110_000);
  });

  it("falls back to a conservative byte estimate when stale parent transcript has no usage", async () => {
    const root = await makeRoot("openclaw-parent-fork-byte-estimate-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-no-usage-transcript";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }),
    ];
    for (let index = 0; index < 24; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `u${index}`,
          parentId: index === 0 ? null : `a${index - 1}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: `turn-${index} ${"x".repeat(24_000)}` },
        }),
      );
    }
    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });

  it("uses the latest usage snapshot instead of tail aggregates for parent fork checks", async () => {
    const root = await makeRoot("openclaw-parent-fork-latest-usage-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-multiple-usage-transcript";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "older",
            usage: { input: 60_000, output: 5_000 },
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "latest",
            usage: { input: 70_000, output: 8_000 },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBe(78_000);
  });

  it("keeps parent fork checks conservative for content appended after latest usage", async () => {
    const root = await makeRoot("openclaw-parent-fork-post-usage-tail-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-post-usage-tail";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "latest model call",
            usage: { input: 40_000, output: 2_000 },
          },
        }),
        JSON.stringify({
          message: {
            role: "tool",
            content: `large appended tool result ${"x".repeat(450_000)}`,
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });
});

describe("forkSessionFromParentRuntime", () => {
  it("forks the active branch without synchronously opening the session manager", async () => {
    const root = await makeRoot("openclaw-parent-fork-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    const parentSessionId = "parent-session";
    const lines = [
      {
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-05-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        type: "label",
        id: "label-1",
        parentId: "assistant-1",
        timestamp: "2026-05-01T00:00:03.000Z",
        targetId: "user-1",
        label: "start",
      },
    ];
    await fs.writeFile(
      parentSessionFile,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (fork === null) {
      throw new Error("Expected forked session");
    }
    expect(fork.sessionFile).toContain(sessionsDir);
    expect(fork.sessionId).not.toBe(parentSessionId);
    const raw = await fs.readFile(fork.sessionFile, "utf-8");
    const forkedEntries = raw
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const resolvedParentSessionFile = await fs.realpath(parentSessionFile);
    const forkedHeader = forkedEntries[0];
    expect(forkedHeader?.type).toBe("session");
    expect(forkedHeader?.id).toBe(fork.sessionId);
    expect(forkedHeader?.cwd).toBe(cwd);
    expect(forkedHeader?.parentSession).toBe(resolvedParentSessionFile);
    expect(forkedEntries.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "label",
    ]);
    const forkedLabel = forkedEntries.at(-1);
    expect(forkedLabel?.type).toBe("label");
    expect(forkedLabel?.targetId).toBe("user-1");
    expect(forkedLabel?.label).toBe("start");
  });

  it("creates a header-only child when the parent has no entries", async () => {
    const root = await makeRoot("openclaw-parent-fork-empty-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const parentSessionId = "parent-empty";
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd: root,
      })}\n`,
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session entry");
    }
    const raw = await fs.readFile(fork.sessionFile, "utf-8");
    const lines = raw.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    const resolvedParentSessionFile = await fs.realpath(parentSessionFile);
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(header.type).toBe("session");
    expect(header.id).toBe(fork.sessionId);
    expect(header.parentSession).toBe(resolvedParentSessionFile);
  });
});
