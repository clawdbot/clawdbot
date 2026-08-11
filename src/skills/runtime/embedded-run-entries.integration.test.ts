// Embedded run entry integration tests cover persisted runtime skill entries.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";

const tempDirs = createTempDirTracker();
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function restoreBundledPluginsDir() {
  if (originalBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    return;
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledDir;
}

async function setupBundledDiffsPlugin() {
  const bundledPluginsDir = tempDirs.make("openclaw-bundled-");
  const workspaceDir = tempDirs.make("openclaw-workspace-");
  const pluginRoot = path.join(bundledPluginsDir, "diffs");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "diffs",
    skillId: "diffs",
    skillDescription: "runtime integration test",
  });

  return { bundledPluginsDir, workspaceDir };
}

async function resolveBundledDiffsSkillEntries(config?: OpenClawConfig) {
  const { bundledPluginsDir, workspaceDir } = await setupBundledDiffsPlugin();
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

  return resolveEmbeddedRunSkillEntries({ workspaceDir, ...(config ? { config } : {}) });
}

afterEach(() => {
  restoreBundledPluginsDir();
  tempDirs.cleanup();
});

describe("resolveEmbeddedRunSkillEntries (integration)", () => {
  it("loads bundled diffs skill when explicitly enabled in config", async () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          diffs: { enabled: true },
        },
      },
    };

    const result = await resolveBundledDiffsSkillEntries(config);

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(result.skillEntries.map((entry) => entry.skill.name)).toContain("diffs");
  });

  it("skips bundled diffs skill when config is missing", async () => {
    const result = await resolveBundledDiffsSkillEntries();

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(result.skillEntries.map((entry) => entry.skill.name)).not.toContain("diffs");
  });
});
