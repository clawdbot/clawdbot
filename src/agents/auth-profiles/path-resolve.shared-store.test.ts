import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

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
    const { resolveSharedAuthStorePath } = await import("./path-resolve.js");
    const { resolveSharedMainAuthAgentDir } = await import("./shared-main-dir.js");
    const legacyDir = resolveSharedMainAuthAgentDir(env);

    expect(resolveSharedAuthStorePath(env)).toBe(path.join(legacyDir, "openclaw-agent.sqlite"));

    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const aliasEnv = {
      ...env,
      OPENCLAW_STATE_DIR: path.join(env.OPENCLAW_STATE_DIR ?? "", "."),
    };

    expect(resolveSharedAuthStorePath(aliasEnv)).toBe(
      path.join(legacyDir, "openclaw-agent.sqlite"),
    );
  });

  it("resolves the relocated store to the canonical shared state database", async () => {
    const env = makeStateEnv();
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");

    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
    expect(resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
  });

  it("keeps an explicit agent directory outside durable shared state", async () => {
    const env = makeStateEnv();
    const runtimeAgentDir = tempDirs.make("openclaw-runtime-auth-");
    env.OPENCLAW_AGENT_DIR = runtimeAgentDir;
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");

    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "legacy-main" });
    expect(resolveSharedAuthStorePath(env)).toBe(
      path.join(runtimeAgentDir, "openclaw-agent.sqlite"),
    );
    expect(resolveSharedAuthStorePath(env)).not.toContain(env.OPENCLAW_STATE_DIR);
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

    expect(() => resolveSharedAuthStoreOwnership(secondEnv)).toThrow(
      expect.objectContaining({
        name: "InvalidSharedAuthStoreOwnershipError",
        code: "INVALID_SHARED_AUTH_STORE_OWNERSHIP",
        action: "openclaw doctor --fix",
      }),
    );
    expect(resolveSharedAuthStoreOwnership(firstEnv)).toEqual({ location: "legacy-main" });
  });
});
