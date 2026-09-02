import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const sessionKey = "agent:main:main";
let tempDir = "";
let scope: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionKey: string;
  storePath: string;
};

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-entry-revalidation-"));
  scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "state") },
    sessionKey,
    storePath: path.join(tempDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(scope, { model: "gpt-5.5", sessionId: "session-1", updatedAt: 10 });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function mutateRowOutOfBand(patch: Record<string, string>): void {
  // Simulate another writer landing between preparation and commit.
  const db = new DatabaseSync(scope.storePath);
  try {
    const entries = Object.entries(patch);
    const setters = entries.map(([key]) => `'$.${key}', ?`).join(", ");
    db.prepare(
      `UPDATE session_nodes SET entry_json = json_set(entry_json, ${setters}) WHERE session_key = ?`,
    ).run(...entries.map(([, value]) => value), sessionKey);
  } finally {
    db.close();
  }
}

describe("patch commit revalidation", () => {
  it("commits the patch when the persisted row is unchanged since preparation", async () => {
    const persisted = await patchSessionEntryCore(scope, () => ({ model: "gpt-5.6" }));
    expect(persisted).toMatchObject({ model: "gpt-5.6", sessionId: "session-1" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
      model: "gpt-5.6",
      sessionId: "session-1",
    });
  });

  it("rejects the commit when the row changed while the update callback ran", async () => {
    await expect(
      patchSessionEntryCore(scope, () => {
        mutateRowOutOfBand({ model: "gpt-5.7" });
        return { label: "renamed" };
      }),
    ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({ model: "gpt-5.7" });
    expect(loadExactSessionEntry(scope)?.entry.label).toBeUndefined();
  });

  it("rejects a lifecycle-target patch when the row changed while the update callback ran", async () => {
    await expect(
      patchSessionEntryTarget(
        {
          agentId: scope.agentId,
          storePath: scope.storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        },
        () => {
          mutateRowOutOfBand({ model: "gpt-5.8" });
          return { label: "renamed" };
        },
      ),
    ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({ model: "gpt-5.8" });
  });

  it("still publishes an identity replacement when a patch rotates the session id", async () => {
    const mutations: unknown[] = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      await patchSessionEntryCore(scope, () => ({ sessionId: "session-2" }));
    } finally {
      unsubscribe();
    }
    expect(mutations).toContainEqual(
      expect.objectContaining({
        kind: "replace",
        previous: expect.objectContaining({ sessionId: "session-1", sessionKeys: [sessionKey] }),
        current: expect.objectContaining({ sessionId: "session-2", sessionKeys: [sessionKey] }),
      }),
    );
  });

  it("does not publish an identity mutation when a patch keeps the session id", async () => {
    const mutations: unknown[] = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      await patchSessionEntryCore(scope, () => ({ updatedAt: 20 }));
    } finally {
      unsubscribe();
    }
    expect(mutations).toEqual([]);
  });
});
