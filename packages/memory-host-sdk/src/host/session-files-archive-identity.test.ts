import fs from "node:fs/promises";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { listSessionTranscriptCorpusEntriesForAgent } from "./session-files.js";

describe("session archive identity", () => {
  it("keeps registered archives from a shared custom store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.root, "custom", "shared.sqlite");
      const sessionId = `oversized-${"x".repeat(300)}`;
      const sessionKey = "agent:main:chat:archived-custom";
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await state.writeConfig({ session: { store: storePath } });
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        { message: { role: "user", content: "Retain custom-store archive identity." } },
      );
      const deleted = await deleteSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      closeOpenClawAgentDatabasesForTest();

      const archivedPath = deleted.archivedTranscripts[0]?.archivedPath;
      expect(archivedPath).toEqual(expect.any(String));
      await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
        expect.objectContaining({
          artifactKind: "archive-artifact",
          sessionFile: archivedPath,
          sessionId,
          sessionKey,
          storePath,
        }),
      );
    });
  });
});
