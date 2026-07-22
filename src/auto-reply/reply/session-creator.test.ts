import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { initSessionState } from "./session.js";

let tempDir: string | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  if (tempDir) {
    await fs.rm(tempDir, { force: true, recursive: true });
    tempDir = undefined;
  }
});

it("clears the previous creator when an ownerless turn starts a new generation", async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-creator-"));
  const storePath = path.join(tempDir, "sessions.json");
  const sessionKey = "agent:main:telegram:chat:creator";
  await upsertSessionEntry(
    { sessionKey, storePath },
    {
      createdBy: { id: "alice@example.com", label: "Alice" },
      sessionId: "owned-session",
      updatedAt: 1,
    },
  );

  const result = await initSessionState({
    ctx: { Body: "/new", CommandBody: "/new", SessionKey: sessionKey },
    cfg: { session: { store: storePath } } as OpenClawConfig,
    commandAuthorized: true,
  });

  expect(result.isNewSession).toBe(true);
  expect(result.sessionEntry).not.toHaveProperty("createdBy");
});
