/**
 * Direct-import tests for auth profile path helpers.
 * Calls path-resolve exports directly so coverage attribution stays honest
 * despite the public paths.ts re-export barrel.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import {
  resolveAuthStatePath,
  resolveAuthStatePathForDisplay,
  resolveAuthStorePath,
  resolveAuthStorePathForDisplay,
  resolveLegacyAuthStorePath,
} from "./path-resolve.js";

describe("path-resolve helpers (direct-import coverage attribution)", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-path-direct-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
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

  it("resolveAuthStorePathForDisplay returns the resolved path for a non-tilde input", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStorePathForDisplay(agentDir);
    expect(resolved.startsWith(stateDir)).toBe(true);
    expect(path.basename(resolved)).toBe("openclaw-agent.sqlite");
  });

  it("resolveAuthStorePathForDisplay expands a tilde-rooted agent dir to the sqlite store", () => {
    const tildeAgentDir = "~fake-openclaw-no-expand";
    const resolved = resolveAuthStorePathForDisplay(tildeAgentDir);
    expect(resolved).toBe(path.resolve(tildeAgentDir, "openclaw-agent.sqlite"));
  });

  it("resolveAuthStatePathForDisplay returns the sqlite auth state store", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStatePathForDisplay(agentDir);
    expect(resolved).toBe(path.join(agentDir, "openclaw-agent.sqlite"));
  });
});
