import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import {
  getSessionEntry,
  loadSessionStore,
  patchSessionEntry,
  updateSessionStore,
  upsertSessionEntry,
} from "./session-store-runtime.js";

const databases = new Set<string>();
afterEach(() => {
  for (const database of databases) {
    closeOpenClawAgentDatabaseByPath(database);
  }
  databases.clear();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["upsert", "whole-store", "patch"] as const)(
  "preserves private history provenance across a public %s without accepting injected ownership",
  async (operation) => {
    const storePath = path.join(tempDirs.make("sdk-cli-history-"), "openclaw-agent.sqlite");
    databases.add(storePath);
    const sessionKey = "agent:main:history";
    const scope = { sessionKey, storePath };
    const initial: InternalSessionEntry = {
      sessionId: "history-session",
      updatedAt: 1,
      cliHistoryBoundary: {
        version: 1,
        sessionId: "history-session",
        state: "known",
        authFingerprint: "1".repeat(64),
        generation: "history-generation",
        maxSeq: 7,
        writerRunId: "history-owner",
      },
    };
    await patchSessionEntryCore(scope, () => initial, {
      fallbackEntry: initial,
      replaceEntry: true,
      skipMaintenance: true,
    });
    const publicEntry = getSessionEntry(scope);
    if (!publicEntry) {
      throw new Error("Missing seeded session");
    }
    expect(publicEntry).not.toHaveProperty("cliHistoryBoundary");
    expect(loadSessionStore(storePath)[sessionKey]).not.toHaveProperty("cliHistoryBoundary");
    const candidate = {
      ...publicEntry,
      label: "updated",
      cliHistoryBoundary: { ...initial.cliHistoryBoundary, authFingerprint: "2".repeat(64) },
    };
    if (operation === "upsert") {
      await upsertSessionEntry({ ...scope, entry: candidate });
    } else if (operation === "whole-store") {
      await updateSessionStore(
        storePath,
        (store) => {
          expect(store[sessionKey]).not.toHaveProperty("cliHistoryBoundary");
          store[sessionKey] = candidate;
        },
        { skipMaintenance: true },
      );
    } else {
      await patchSessionEntry({ ...scope, update: () => candidate });
    }
    expect(getSessionEntry(scope)?.label).toBe("updated");
    expect(getSessionEntry(scope)).not.toHaveProperty("cliHistoryBoundary");
    const persisted: InternalSessionEntry | undefined = loadSessionEntry(scope);
    expect(persisted?.cliHistoryBoundary).toEqual(initial.cliHistoryBoundary);
  },
);
