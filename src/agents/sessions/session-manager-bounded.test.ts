import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("bounds runtime hydration while preserving older durable transcript rows on rewrites", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-");
  const storePath = path.join(dir, "sessions.json");
  const scope = {
    agentId: "main",
    sessionId: "bounded-runtime-session",
    sessionKey: "agent:main:bounded-runtime-session",
    storePath,
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const content of ["oldest", "middle", "latest"]) {
    await appendTranscriptMessage(scope, { cwd: dir, message: { role: "user", content } });
  }

  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 2,
  });

  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "middle" },
    { content: "latest" },
  ]);
  expect(manager.getEntries()).toHaveLength(2);
  expect(
    manager.removeTrailingEntries(
      (entry) => entry.type === "message" && entry.message.content === "latest",
    ),
  ).toBe(1);
  await expect(loadTranscriptEvents(scope)).resolves.toMatchObject([
    { type: "session" },
    { message: { content: "oldest" } },
    { message: { content: "middle" } },
  ]);
});
