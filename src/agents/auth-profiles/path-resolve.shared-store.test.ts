import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfigMachineState } from "../../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";

const tempDirs = new Set<string>();

async function makeStateEnv(): Promise<NodeJS.ProcessEnv> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-auth-store-"));
  tempDirs.add(stateDir);
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
}

describe("shared auth store path resolution", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await Promise.all(
      [...tempDirs].map(async (stateDir) => {
        await fs.rm(stateDir, { recursive: true, force: true });
        tempDirs.delete(stateDir);
      }),
    );
  });

  it("keeps the absent ownership record pinned to the shipped legacy-main path", async () => {
    const env = await makeStateEnv();
    const { resolveSharedAuthStoreDir, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");
    const { resolveSharedMainAuthAgentDir } = await import("./shared-main-dir.js");
    const legacyDir = resolveSharedMainAuthAgentDir(env);

    expect(resolveSharedAuthStoreDir(env)).toBe(legacyDir);
    expect(resolveSharedAuthStorePath(env)).toBe(path.join(legacyDir, "openclaw-agent.sqlite"));

    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });

    expect(resolveSharedAuthStoreDir(env)).toBe(legacyDir);
    expect(resolveSharedAuthStorePath(env)).toBe(path.join(legacyDir, "openclaw-agent.sqlite"));
  });

  it("resolves a preexisting state-db ownership record", async () => {
    const env = await makeStateEnv();
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const { resolveSharedAuthStoreDir, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");

    expect(resolveSharedAuthStoreDir(env)).toBe(resolveOpenClawStateSqliteDir(env));
    expect(resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
  });

  it("rejects a malformed ownership record instead of guessing a store", async () => {
    const env = await makeStateEnv();
    writeConfigMachineState("auth.sharedStore", { location: "legacy-main", extra: true }, { env });
    const { resolveSharedAuthStorePath } = await import("./path-resolve.js");

    expect(() => resolveSharedAuthStorePath(env)).toThrow("auth.sharedStore is invalid");
  });
});
