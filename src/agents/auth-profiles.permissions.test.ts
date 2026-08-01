// Auth-profile saves must not report a failed transaction after rows became durable.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    if (chmodFailHook.error) {
      throw chmodFailHook.error;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

const {
  readPersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} = await import("./auth-profiles/sqlite.js");
const {
  captureAuthProfileStorePersistenceSnapshot,
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} = await import("./auth-profiles/store.js");
const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("auth-profile database permission repair", () => {
  afterEach(() => {
    chmodFailHook.error = undefined;
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("keeps captured auth rows when pre-commit permission repair fails", () => {
    const stateDir = tempDirs.make("openclaw-auth-chmod-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const agentDir = join(stateDir, "agents", "main", "agent");
    const initial: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "fake-initial",
        },
      },
    };
    const next: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "fake-next",
        },
      },
    };
    writePersistedAuthProfileStoreRaw(initial, agentDir);
    const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);
    const permissionError = Object.assign(new Error("EACCES: chmod failed"), {
      code: "EACCES",
    });
    chmodFailHook.error = permissionError;

    expect(() =>
      saveAuthProfileStoreIfPersistenceSnapshotMatches({
        agentDir,
        snapshot,
        store: next,
        options: {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        },
      }),
    ).toThrow(permissionError);

    chmodFailHook.error = undefined;
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(initial);
  });

  it("does not publish a caller-owned save before permission repair commits", () => {
    const stateDir = tempDirs.make("openclaw-auth-overload-chmod-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const agentDir = join(stateDir, "agents", "main", "agent");
    const initial: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "fake-initial" },
      },
    };
    const next: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "fake-next" },
      },
    };
    writePersistedAuthProfileStoreRaw(initial, agentDir);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: initial }]);
    const permissionError = Object.assign(new Error("EACCES: chmod failed"), {
      code: "EACCES",
    });
    chmodFailHook.error = permissionError;

    expect(() =>
      runAuthProfileWriteTransaction(agentDir, (database) => {
        saveAuthProfileStore(next, agentDir, undefined, database);
      }),
    ).toThrow(permissionError);

    chmodFailHook.error = undefined;
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(initial);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toEqual(initial);
  });
});
