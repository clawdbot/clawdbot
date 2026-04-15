import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { maybeCompactCodexAppServerSession, __testing } from "./compact.js";
import type { CodexServerNotification } from "./protocol.js";
import { writeCodexAppServerBinding } from "./session-binding.js";

let tempDir: string;

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compact-"));
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("waits for native app-server compaction before reporting success", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      currentTokenCount: 123,
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });

    let settled = false;
    void pendingResult.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    const result = await pendingResult;

    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 123,
        details: {
          backend: "codex-app-server",
          threadId: "thread-1",
          signal: "thread/compacted",
          turnId: "turn-1",
        },
      },
    });
  });

  it("accepts native context-compaction item completion as success", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "compact-1" },
      },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: true,
      compacted: true,
      result: {
        details: {
          signal: "item/completed",
          itemId: "compact-1",
        },
      },
    });
  });
});

function createFakeCodexClient(): {
  client: CodexAppServerClient;
  request: ReturnType<typeof vi.fn>;
  emit: (notification: CodexServerNotification) => void;
} {
  const handlers = new Set<(notification: CodexServerNotification) => void>();
  const request = vi.fn(async () => ({}));
  return {
    client: {
      request,
      addNotificationHandler(handler: (notification: CodexServerNotification) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    } as unknown as CodexAppServerClient,
    request,
    emit(notification: CodexServerNotification): void {
      for (const handler of handlers) {
        handler(notification);
      }
    },
  };
}
