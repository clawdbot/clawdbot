import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
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

describe("resolveParentForkTokenCountRuntime", () => {
  it("falls back to transcript-estimated tokens when cached totals are stale", async () => {
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
      const body = `turn-${index} ${"x".repeat(12_000)}`;
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
          message: { role: "assistant", content: body },
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

    const tokens = resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });
});
