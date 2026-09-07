// Plugin hook tests cover hook discovery from plugin manifests and packages.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";
import { resolvePluginHookDirs } from "./plugin-hooks.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

describe("bundle plugin hooks", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let previousBundledHooksDir: string | undefined;

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-hooks-"));
  });

  beforeEach(async () => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fsp.mkdir(workspaceDir, { recursive: true });
    previousBundledHooksDir = process.env.OPENCLAW_BUNDLED_HOOKS_DIR;
    process.env.OPENCLAW_BUNDLED_HOOKS_DIR = "/nonexistent/bundled/hooks";
  });

  afterEach(() => {
    setCurrentPluginMetadataSnapshot(undefined);
    vi.restoreAllMocks();
    clearInternalHooks();
    setInternalHooksEnabled(true);
    if (previousBundledHooksDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_HOOKS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_HOOKS_DIR = previousBundledHooksDir;
    }
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function writeBundleHookFixture(): Promise<string> {
    const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", "sample-bundle");
    const hookDir = path.join(bundleRoot, "hooks", "bundle-hook");
    await fsp.mkdir(path.join(bundleRoot, ".codex-plugin"), { recursive: true });
    await fsp.mkdir(hookDir, { recursive: true });
    await fsp.writeFile(
      path.join(bundleRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "Sample Bundle",
        hooks: "hooks",
      }),
      "utf-8",
    );
    await fsp.writeFile(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        "name: bundle-hook",
        'description: "Bundle hook"',
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# Bundle hook",
        "",
      ].join("\n"),
      "utf-8",
    );
    await fsp.writeFile(
      path.join(hookDir, "handler.js"),
      'export default async function(event) { event.messages.push("bundle-hook-ok"); }\n',
      "utf-8",
    );
    return bundleRoot;
  }

  function createConfig(enabled: boolean): OpenClawConfig {
    return {
      hooks: {
        internal: {
          enabled: true,
        },
      },
      plugins: {
        entries: {
          "sample-bundle": {
            enabled,
          },
        },
      },
    };
  }

  function requireOnlyHookEntry(entries: ReturnType<typeof loadWorkspaceHookEntries>) {
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) {
      throw new Error("Expected bundled hook entry");
    }
    return entry;
  }

  it("exposes enabled bundle hook dirs as plugin-managed hook entries", async () => {
    const bundleRoot = await writeBundleHookFixture();

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      config: createConfig(true),
    });

    const entry = requireOnlyHookEntry(entries);
    expect(entry.hook.name).toBe("bundle-hook");
    expect(entry.hook.source).toBe("openclaw-plugin");
    expect(entry.hook.pluginId).toBe("sample-bundle");
    expect(entry.hook.baseDir).toBe(
      fs.realpathSync.native(path.join(bundleRoot, "hooks", "bundle-hook")),
    );
    expect(entry.metadata?.events).toEqual(["command:new"]);
  });

  it("reuses published plugin metadata without rescanning manifests", async () => {
    const bundleRoot = await writeBundleHookFixture();
    const config = createConfig(true);
    const snapshot = loadPluginMetadataSnapshot({ config, workspaceDir, env: process.env });
    setCurrentPluginMetadataSnapshot(snapshot, { config, workspaceDir });
    const hookDir = fs.realpathSync.native(path.join(bundleRoot, "hooks"));
    const manifestRegistry = await import("../plugins/manifest-registry-installed.js");
    const scanManifests = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryForInstalledIndex");

    for (let iteration = 0; iteration < 2; iteration += 1) {
      expect(resolvePluginHookDirs({ workspaceDir, config })).toEqual([
        { dir: hookDir, pluginId: "sample-bundle", rootDir: fs.realpathSync.native(bundleRoot) },
      ]);
    }

    expect(scanManifests).not.toHaveBeenCalled();
  });

  it("commits candidate plugin hook policy from the immutable Gateway inventory", async () => {
    await writeBundleHookFixture();
    const config = createConfig(true);
    const snapshot = loadPluginMetadataSnapshot({ config, workspaceDir, env: process.env });
    setGatewayPluginMetadataSnapshot(snapshot, { config, workspaceDir });
    const manifestRegistry = await import("../plugins/manifest-registry-installed.js");
    const scanManifests = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryForInstalledIndex");
    const initial = await prepareInternalHooks(config, workspaceDir);
    expect(initial.loadedCount).toBe(1);
    initial.commit();

    for (const enabled of [false, true]) {
      const candidate = await prepareInternalHooks(createConfig(enabled), workspaceDir);
      expect(candidate.loadedCount).toBe(enabled ? 1 : 0);
      const beforeCommit = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(beforeCommit);
      expect(beforeCommit.messages).toEqual(enabled ? [] : ["bundle-hook-ok"]);
      candidate.commit();
      const afterCommit = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(afterCommit);
      expect(afterCommit.messages).toEqual(enabled ? ["bundle-hook-ok"] : []);
    }
    expect(scanManifests).not.toHaveBeenCalled();
  });

  it.each(["root", "descriptor"])(
    "retains a selected plugin hook after losing its %s until the plugin is disabled",
    async (failure) => {
      const bundleRoot = await writeBundleHookFixture();
      const config = createConfig(true);
      const snapshot = loadPluginMetadataSnapshot({ config, workspaceDir, env: process.env });
      setGatewayPluginMetadataSnapshot(snapshot, { config, workspaceDir });
      (await prepareInternalHooks(config, workspaceDir)).commit();
      const hookRoot = path.join(bundleRoot, "hooks");
      await fsp.rm(failure === "root" ? hookRoot : path.join(hookRoot, "bundle-hook", "HOOK.md"), {
        recursive: true,
      });

      await expect(prepareInternalHooks(config, workspaceDir)).rejects.toThrow();
      const retained = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(retained);
      expect(retained.messages).toEqual(["bundle-hook-ok"]);

      (await prepareInternalHooks(createConfig(false), workspaceDir)).commit();
      const disabled = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(disabled);
      expect(disabled.messages).toEqual([]);
    },
  );

  it("skips disabled bundle hooks", async () => {
    await writeBundleHookFixture();

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      config: createConfig(false),
    });
    expect(entries).toHaveLength(0);
  });

  it("does not treat Claude hooks.json bundles as OpenClaw hook packs", async () => {
    const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", "claude-bundle");
    await fsp.mkdir(path.join(bundleRoot, ".claude-plugin"), { recursive: true });
    await fsp.mkdir(path.join(bundleRoot, "hooks"), { recursive: true });
    await fsp.writeFile(
      path.join(bundleRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "Claude Bundle",
        hooks: [{ type: "command" }],
      }),
      "utf-8",
    );
    await fsp.writeFile(path.join(bundleRoot, "hooks", "hooks.json"), '{"hooks":[]}', "utf-8");

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      config: {
        hooks: { internal: { enabled: true } },
        plugins: { entries: { "claude-bundle": { enabled: true } } },
      },
    });

    expect(entries).toHaveLength(0);
  });
});
