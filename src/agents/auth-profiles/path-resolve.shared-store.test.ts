import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStateEnv(): NodeJS.ProcessEnv {
  const stateDir = tempDirs.make("openclaw-shared-auth-store-");
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
}

describe("shared auth store path resolution", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps the absent ownership record pinned to the shipped legacy-main path", async () => {
    const env = makeStateEnv();
    const { resolveSharedAuthStoreDir, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");
    const { resolveSharedMainAuthAgentDir } = await import("./shared-main-dir.js");
    const legacyDir = resolveSharedMainAuthAgentDir(env);

    expect(resolveSharedAuthStoreDir(env)).toBe(legacyDir);
    expect(resolveSharedAuthStorePath(env)).toBe(path.join(legacyDir, "openclaw-agent.sqlite"));

    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const aliasEnv = {
      ...env,
      OPENCLAW_STATE_DIR: path.join(env.OPENCLAW_STATE_DIR ?? "", "."),
    };

    expect(resolveSharedAuthStoreDir(aliasEnv)).toBe(legacyDir);
    expect(resolveSharedAuthStorePath(aliasEnv)).toBe(
      path.join(legacyDir, "openclaw-agent.sqlite"),
    );
  });

  it("fails closed when the ownership record says state-db", async () => {
    const env = makeStateEnv();
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const {
      resolveSharedAuthStoreDir,
      resolveSharedAuthStoreOwnership,
      resolveSharedAuthStorePath,
    } = await import("./path-resolve.js");

    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
    for (const resolvePath of [resolveSharedAuthStoreDir, resolveSharedAuthStorePath]) {
      try {
        resolvePath(env);
        throw new Error("expected relocated shared auth resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          name: "SharedAuthStoreRelocatedUnsupportedError",
          code: "SHARED_AUTH_STORE_RELOCATED_UNSUPPORTED",
          action: "openclaw doctor --fix",
          location: "state-db",
          message: expect.stringContaining("this build cannot serve it"),
        });
      }
    }
  });

  it("caches ownership independently for each canonical state root", async () => {
    const firstEnv = makeStateEnv();
    const secondEnv = makeStateEnv();
    const { resolveSharedAuthStoreOwnership } = await import("./path-resolve.js");
    expect(resolveSharedAuthStoreOwnership(firstEnv)).toEqual({ location: "legacy-main" });

    writeConfigMachineState(
      "auth.sharedStore",
      { location: "legacy-main", extra: true },
      { env: secondEnv },
    );

    expect(() => resolveSharedAuthStoreOwnership(secondEnv)).toThrow("auth.sharedStore is invalid");
    expect(resolveSharedAuthStoreOwnership(firstEnv)).toEqual({ location: "legacy-main" });
  });
});
