// Tests session fork runtime behavior and copied session artifacts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  forkSessionEntryFromParent,
  forkSessionFromParent,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
  resolveParentForkDecision,
} from "./session-fork.js";
import { resolveParentForkTokenCountRuntime } from "./session-fork.runtime.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("parent fork policy", () => {
  it("rejects model-selection-locked parent context", async () => {
    const parentEntry: SessionEntry = {
      sessionId: "locked-parent",
      modelSelectionLocked: true,
      updatedAt: 1,
    };
    await expect(
      resolveParentForkDecision({
        parentEntry,
        storePath: "/tmp/unused-sessions.json",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
    await expect(
      forkSessionFromParent({
        agentId: "main",
        parentEntry,
        parentSessionKey: "agent:main:main",
        sessionKey: "agent:main:subagent:child",
        storePath: "/tmp/unused-sessions.json",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  });

  it("rejects a newer locked parent alias shadowed by a stale canonical row", async () => {
    const root = await makeRoot("openclaw-parent-fork-locked-alias-");
    const storePath = path.join(root, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "stale-canonical-parent",
          updatedAt: 1,
        },
        main: {
          sessionId: "fresh-locked-parent",
          modelSelectionLocked: true,
          updatedAt: 2,
        },
      }),
      "utf-8",
    );

    await expect(
      forkSessionEntryFromParent({
        agentId: "main",
        fallbackEntry: { sessionId: "", updatedAt: 3 },
        parentSessionKey: "agent:main:main",
        parentStoreKeys: ["agent:main:main", "main"],
        sessionKey: "agent:main:subagent:child",
        storePath,
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
    expect(stored["agent:main:subagent:child"]).toBeUndefined();
  });
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
          type: "message",
          id: "active-usage",
          parentId: null,
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

  it("does not reconstruct parent context from billing buckets when context is unavailable", async () => {
    const root = await makeRoot("openclaw-parent-fork-unavailable-context-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-unavailable-context";
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
            content: "latest",
            usage: {
              input: 12,
              output: 15_104,
              cacheRead: 819_661,
              cacheWrite: 93_130,
              contextUsage: { state: "unavailable" },
              total: 927_907,
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 4_567,
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBe(4_567);
  });

  it("uses the exact final-iteration total when context usage is available", async () => {
    const root = await makeRoot("openclaw-parent-fork-exact-context-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-exact-context";
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
          type: "message",
          id: "active-usage",
          parentId: null,
          message: {
            role: "assistant",
            content: "latest",
            usage: {
              input: 12,
              output: 15_104,
              cacheRead: 819_661,
              cacheWrite: 93_130,
              contextUsage: {
                state: "available",
                promptTokens: 148_874,
                totalTokens: 163_978,
              },
              total: 927_907,
            },
          },
        }),
        JSON.stringify({
          type: "message",
          id: "inactive-side-usage",
          parentId: "active-usage",
          message: {
            role: "assistant",
            content: `side branch ${"x".repeat(1_100_000)}`,
            usage: {
              input: 9_000,
              output: 1_000,
              contextUsage: {
                state: "available",
                promptTokens: 9_000,
                totalTokens: 10_000,
              },
            },
          },
        }),
        JSON.stringify({
          type: "leaf",
          id: "active-leaf",
          parentId: "inactive-side-usage",
          targetId: "active-usage",
        }),
      ].join("\n"),
      "utf-8",
    );

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 900_000,
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBe(163_978);
  });

  it("adds only post-usage transcript pressure to an exact context snapshot", async () => {
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
            usage: {
              input: 12,
              output: 10_000,
              contextUsage: {
                state: "available",
                promptTokens: 70_000,
                totalTokens: 80_000,
              },
            },
          },
        }),
        JSON.stringify({
          message: {
            role: "tool",
            content: `large appended tool result ${"x".repeat(100_000)}`,
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
    expect(tokens).toBeLessThan(110_000);
  });
});
