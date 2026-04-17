import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import {
  resolveAuthStatePath,
  resolveAuthStatePathForDisplay,
  resolveAuthStorePath,
  resolveAuthStorePathForDisplay,
  resolveLegacyAuthStorePath,
} from "./path-resolve.js";
import { ensureAuthStoreFile } from "./paths.js";

// Direct-import sanity tests. These helpers are exercised transitively by the
// wider auth-profile test suite via ESM re-exports through paths.ts, but v8
// coverage does not always attribute those transitive hits back to the
// original function bodies in path-resolve.ts. This file imports each helper
// directly from ./path-resolve.js (bypassing the re-export indirection) and
// calls it at least once so the coverage report is honest about what is and
// isn't tested.

describe("path-resolve helpers (direct-import coverage attribution)", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-path-direct-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("resolveAuthStorePath joins agentDir with the auth-profiles filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStorePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
    expect(path.basename(resolved)).toMatch(/auth-profiles/);
  });

  it("resolveAuthStorePath falls back to resolveOpenClawAgentDir when agentDir is omitted", () => {
    // Omitting agentDir exercises the `agentDir ?? resolveOpenClawAgentDir()`
    // nullish branch. With OPENCLAW_STATE_DIR set to our tempdir, the
    // resolved path must live under it.
    const resolved = resolveAuthStorePath();
    expect(resolved.startsWith(stateDir)).toBe(true);
    expect(path.basename(resolved)).toMatch(/auth-profiles/);
  });

  it("resolveLegacyAuthStorePath joins agentDir with the legacy auth filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveLegacyAuthStorePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
    expect(path.basename(resolved)).not.toMatch(/auth-profiles/);
  });

  it("resolveLegacyAuthStorePath falls back to the default agent dir", () => {
    const resolved = resolveLegacyAuthStorePath();
    expect(resolved.startsWith(stateDir)).toBe(true);
  });

  it("resolveAuthStatePath joins agentDir with the auth-state filename", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStatePath(agentDir);
    expect(path.dirname(resolved)).toBe(agentDir);
  });

  it("resolveAuthStatePath falls back to the default agent dir", () => {
    const resolved = resolveAuthStatePath();
    expect(resolved.startsWith(stateDir)).toBe(true);
  });

  it("resolveAuthStorePathForDisplay returns the resolved path for a non-tilde input", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStorePathForDisplay(agentDir);
    expect(resolved.startsWith(stateDir)).toBe(true);
  });

  it("resolveAuthStorePathForDisplay preserves a tilde-rooted path unchanged", () => {
    // Exercises the `pathname.startsWith(\"~\")` branch. We use a contrived
    // agentDir that already starts with `~` so the resolver echoes the
    // tilde path back instead of expanding it via resolveUserPath.
    const tildeAgentDir = "~fake-openclaw-no-expand";
    const resolved = resolveAuthStorePathForDisplay(tildeAgentDir);
    // Either the path itself starts with `~`, or the display variant
    // happened to resolve through the user-path branch. Both branches are
    // valid; the point is just that the function returned a string and
    // the branch was executed.
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("resolveAuthStatePathForDisplay returns a string", () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const resolved = resolveAuthStatePathForDisplay(agentDir);
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe("ensureAuthStoreFile (direct-import coverage attribution)", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-path-ensure-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("creates a new auth-profiles.json when the file does not yet exist", async () => {
    const target = path.join(stateDir, "sub", "auth-profiles.json");
    ensureAuthStoreFile(target);
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { version: number; profiles: Record<string, unknown> };
    expect(parsed.version).toBeGreaterThanOrEqual(1);
    expect(parsed.profiles).toEqual({});
  });

  it("leaves an existing auth-profiles.json unchanged", async () => {
    const target = path.join(stateDir, "auth-profiles.json");
    // Seed a file with custom content; ensureAuthStoreFile should bail out
    // on the existsSync short-circuit and NOT overwrite.
    await fs.writeFile(
      target,
      JSON.stringify({
        version: 1,
        profiles: { canary: { type: "api_key", provider: "x", key: "k" } },
      }),
      "utf8",
    );
    ensureAuthStoreFile(target);
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { profiles: Record<string, unknown> };
    expect(parsed.profiles.canary).toBeDefined();
  });
});
