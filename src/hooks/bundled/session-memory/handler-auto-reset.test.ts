import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

describe("session-memory automatic reset", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-auto-"));
  });

  afterEach(async () => {
    await flushSessionMemoryWritesForTest();
    await fs.rm(tempDir, { recursive: true, force: true });
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

      await handler(event);
      await flushSessionMemoryWritesForTest();

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      const memoryContent = await fs.readFile(
        path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
        "utf8",
      );
      expect(files).toHaveLength(1);
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: Remember the ${reason} rollover`);
      expect(memoryContent).toContain("assistant: Captured automatically");
    },
  );
});
