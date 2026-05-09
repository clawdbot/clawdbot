import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "./internal-hooks.js";
import { loadInternalHooks } from "./loader.js";
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

  it("loads and executes enabled bundle hooks through the internal hook loader", async () => {
    await writeBundleHookFixture();

    const count = await loadInternalHooks(createConfig(true), workspaceDir);
    expect(count).toBe(1);

    const event = createInternalHookEvent("command", "new", "test-session");
    await triggerInternalHook(event);
    expect(event.messages).toContain("bundle-hook-ok");
  });

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
