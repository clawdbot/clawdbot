import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { createInternalHookEvent } from "../../internal-hooks.js";

const memoryIsolationMocks = vi.hoisted(() => ({
  isMemoryIsolationCutoverAgent: vi.fn(() => false),
  isMemoryIsolationTranscriptPolicyEnforcedInDatabase: vi.fn(() => false),
}));

vi.mock("../../../plugins/memory-cutover.js", () => memoryIsolationMocks);
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-memory automatic reset", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-memory-auto-");
  });

  afterEach(async () => {
    memoryIsolationMocks.isMemoryIsolationCutoverAgent.mockReset().mockReturnValue(false);
    memoryIsolationMocks.isMemoryIsolationTranscriptPolicyEnforcedInDatabase
      .mockReset()
      .mockReturnValue(false);
    await flushSessionMemoryWritesForTest();
  });

  it("does not read transcripts or create workspace memory for an enforced agent", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "enforced-session";
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    memoryIsolationMocks.isMemoryIsolationCutoverAgent.mockReturnValue(true);
    const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
      cfg,
      agentId: "main",
      workspaceDir: tempDir,
      storePath,
      sessionEntry: { sessionId },
      reason: "daily",
    });

    await handler(event);

    expect(memoryIsolationMocks.isMemoryIsolationCutoverAgent).toHaveBeenCalledWith("main");
    await expect(fs.access(path.join(tempDir, "memory"))).rejects.toThrow();
  });

  it.each(["daily", "idle"] as const)(
    "creates memory from the ended session on %s reset",
    async (reason) => {
      const sessionKey = "agent:main:main";
      const sessionId = `${reason}-session`;
      const storePath = path.join(tempDir, "sessions.json");
      const cfg = {
        agents: { defaults: { workspace: tempDir } },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "message",
          id: `${reason}-user`,
          parentId: null,
          message: { role: "user", content: `Remember the ${reason} rollover` },
        },
        {
          type: "message",
          id: `${reason}-assistant`,
          parentId: `${reason}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ]);
      const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId },
        reason,
      });

      const completed = handler(event);
      expect(completed).toBeInstanceOf(Promise);
      await completed;

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      const memoryContent = await fs.readFile(
        path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
        "utf8",
      );
      expect(files).toHaveLength(1);
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: ${JSON.stringify(`Remember the ${reason} rollover`)}`);
      expect(memoryContent).toContain(`assistant: ${JSON.stringify("Captured automatically")}`);
    },
  );
});
