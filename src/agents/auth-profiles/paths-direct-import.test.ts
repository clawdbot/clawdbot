/**
 * Direct-import tests for auth profile path helpers.
 * Calls the owning modules directly so coverage attribution stays honest.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveLegacyAuthProfilesPath as resolveAuthStorePath,
  resolveLegacyAuthStatePath as resolveAuthStatePath,
  resolveLegacyFlatAuthPath as resolveLegacyAuthStorePath,
} from "../../commands/doctor-auth-legacy-paths.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveAuthStatePathForDisplay, resolveAuthStorePathForDisplay } from "./paths.js";
import { writePersistedAuthProfileStoreRaw } from "./sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("auth profile path helpers (direct-import coverage attribution)", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-path-direct-");
  });

  it("resolveAuthStorePath joins agentDir with the auth-profiles filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStorePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
    expect(path.basename(resolved)).toMatch(/auth-profiles/);
  });

  it("resolveAuthStorePath falls back to the default agent dir when agentDir is omitted", () => {
    // Omitting agentDir exercises the default agent-dir branch. With
    // OPENCLAW_STATE_DIR set to our tempdir, the resolved path must live under it.
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const resolved = resolveAuthStorePath();
      expect(resolved.startsWith(stateDir)).toBe(true);
      expect(path.basename(resolved)).toMatch(/auth-profiles/);
    });
  });

  it("honors OPENCLAW_AGENT_DIR in both no-argument auth path implementations", () => {
    const relocatedAgentDir = path.join(stateDir, "relocated-main-agent");
    withEnv({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: relocatedAgentDir }, () => {
      expect(path.dirname(resolveAuthStorePath())).toBe(relocatedAgentDir);
      expect(resolveAuthStorePathForDisplay()).toBe(
        path.join(relocatedAgentDir, "openclaw-agent.sqlite"),
      );
    });
  });

  it("resolveLegacyAuthStorePath joins agentDir with the legacy auth filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveLegacyAuthStorePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
    expect(path.basename(resolved)).not.toMatch(/auth-profiles/);
  });

  it("resolveLegacyAuthStorePath falls back to the default agent dir", () => {
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const resolved = resolveLegacyAuthStorePath();
      expect(resolved.startsWith(stateDir)).toBe(true);
    });
  });

  it("resolveAuthStatePath joins agentDir with the auth-state filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStatePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
  });

  it("resolveAuthStatePath falls back to the default agent dir", () => {
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const resolved = resolveAuthStatePath();
      expect(resolved.startsWith(stateDir)).toBe(true);
    });
  });

  it("uses one database path for an agent-local auth store and its runtime state", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
      const expectedPath = path.join(agentDir, "openclaw-agent.sqlite");
      expect(resolveAuthStorePathForDisplay(agentDir)).toBe(expectedPath);
      expect(resolveAuthStatePathForDisplay(agentDir)).toBe(expectedPath);
    });
  });

  it("falls back to the shared owner for an agent dir that has no local store", () => {
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      // A tilde-rooted dir resolveUserPath cannot expand still must not be reported as the owner:
      // without a local store the loader reads the shared database, so display must name that.
      const resolved = resolveAuthStorePathForDisplay("~fake-openclaw-no-expand");
      expect(resolved).toBe(resolveSharedAuthStorePath());
      expect(resolved.startsWith("~")).toBe(false);
    });
  });
});
