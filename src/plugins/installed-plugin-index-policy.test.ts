// Covers policy-hash invalidation inputs for the persisted installed-plugin index.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

describe("resolveInstalledPluginIndexPolicyHash", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  // Real machine state in isolated roots: module mocks would evict this file
  // from the unit-fast lane and leak across isolate=false workers.
  const makeStateRoot = async (mode?: "compat" | "allowlist"): Promise<string> => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-index-policy-")),
    );
    if (mode) {
      const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      try {
        writeConfigMachineState("plugins.bundledDiscovery", mode);
      } finally {
        envSnapshot.restore();
      }
    }
    return stateDir;
  };

  const envForRoot = (stateDir: string): NodeJS.ProcessEnv => ({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });

  it("changes when the machine-state bundled discovery mode changes", async () => {
    // Regression for #123297's upgrade path: doctor migrates the mode into
    // machine state without touching openclaw.json, so the mode must be a
    // policy-hash input or persisted enabled values stay stale after --fix.
    const config = { plugins: { allow: ["rollover"] } };
    const unsetRoot = await makeStateRoot();
    const compatRoot = await makeStateRoot("compat");
    const allowlistRoot = await makeStateRoot("allowlist");
    try {
      const unset = resolveInstalledPluginIndexPolicyHash(config, envForRoot(unsetRoot));
      const compat = resolveInstalledPluginIndexPolicyHash(config, envForRoot(compatRoot));
      const allowlist = resolveInstalledPluginIndexPolicyHash(config, envForRoot(allowlistRoot));

      expect(compat).not.toBe(unset);
      expect(allowlist).not.toBe(unset);
      expect(allowlist).not.toBe(compat);
    } finally {
      for (const dir of [unsetRoot, compatRoot, allowlistRoot]) {
        await removeBundledDiscoveryStateRoot(dir);
      }
    }
  });

  it("hashes the caller-scoped env's mode, not the process root's", async () => {
    // Two-root regression (#123416): explicit-env snapshot checks must hash
    // that env's mode or persisted indexes leak decisions across roots.
    const compatRoot = await makeStateRoot("compat");
    const plainRoot = await makeStateRoot();
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
    try {
      clearBundledDiscoveryModeMemo();
      const config = { plugins: { allow: ["rollover"] } };
      expect(resolveInstalledPluginIndexPolicyHash(config, envForRoot(compatRoot))).not.toBe(
        resolveInstalledPluginIndexPolicyHash(config),
      );
      // Same root through either spelling hashes identically.
      expect(resolveInstalledPluginIndexPolicyHash(config, envForRoot(plainRoot))).toBe(
        resolveInstalledPluginIndexPolicyHash(config),
      );
    } finally {
      envSnapshot.restore();
      await removeBundledDiscoveryStateRoot(compatRoot);
      await removeBundledDiscoveryStateRoot(plainRoot);
    }
  });

  it("stays stable for an unchanged mode and config", async () => {
    const compatRoot = await makeStateRoot("compat");
    try {
      const config = { plugins: { allow: ["rollover"] } };
      expect(resolveInstalledPluginIndexPolicyHash(config, envForRoot(compatRoot))).toBe(
        resolveInstalledPluginIndexPolicyHash(config, envForRoot(compatRoot)),
      );
    } finally {
      await removeBundledDiscoveryStateRoot(compatRoot);
    }
  });
});
