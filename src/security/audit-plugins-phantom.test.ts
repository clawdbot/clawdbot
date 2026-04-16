import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectPluginsTrustFindings } from "./audit-extra.async.js";

/**
 * Mock listChannelPlugins to return a controlled set of bundled plugin IDs.
 * This lets the tests verify that bundled IDs are excluded from phantom-entry
 * detection without depending on the actual set of shipped channel plugins.
 */
vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [{ id: "bundled-channel-plugin" }],
  // Stubs for other named exports used transitively (keep calls safe to invoke).
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
  normalizeChannelId: () => null,
}));

describe("security audit phantom allowlist detection", () => {
  let fixtureRoot = "";
  let caseId = 0;

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-phantom-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("excludes bundled channel plugin IDs from phantom allowlist warnings", async () => {
    const stateDir = await makeTmpDir("phantom-bundled-excluded");
    // Create an extensions directory with one installed plugin so the phantom
    // check code path is reached (it only runs when pluginDirs.length > 0).
    await fs.mkdir(path.join(stateDir, "extensions", "some-installed-plugin"), {
      recursive: true,
    });

    const cfg: OpenClawConfig = {
      // Allowlist contains a bundled channel ID and an actually-installed plugin ID.
      // Neither should appear as a phantom entry.
      plugins: { allow: ["bundled-channel-plugin", "some-installed-plugin"] },
    };

    const findings = await collectPluginsTrustFindings({ cfg, stateDir });
    const phantomFinding = findings.find((f) => f.checkId === "plugins.allow_phantom_entries");
    expect(phantomFinding).toBeUndefined();
  });

  it("reports phantom entries for allowlisted IDs that are neither installed nor bundled", async () => {
    const stateDir = await makeTmpDir("phantom-reported");
    // Create an extensions directory so the phantom check code path is reached.
    await fs.mkdir(path.join(stateDir, "extensions", "installed-plugin"), { recursive: true });

    const cfg: OpenClawConfig = {
      // "ghost-plugin-xyz" is not installed and not a bundled channel plugin.
      plugins: { allow: ["installed-plugin", "ghost-plugin-xyz"] },
    };

    const findings = await collectPluginsTrustFindings({ cfg, stateDir });
    const phantomFinding = findings.find((f) => f.checkId === "plugins.allow_phantom_entries");
    expect(phantomFinding).toBeDefined();
    expect(phantomFinding?.severity).toBe("warn");
    // The phantom finding must identify the ghost entry…
    expect(phantomFinding?.detail).toContain("ghost-plugin-xyz");
    // …and must NOT implicate the legitimately installed plugin.
    expect(phantomFinding?.detail).not.toContain("installed-plugin");
  });
});
