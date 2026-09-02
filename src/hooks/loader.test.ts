// Hook loader tests cover loading bundled, workspace, and plugin hooks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { captureEnv } from "../test-utils/env.js";
import { hasConfiguredInternalHooks, resolveConfiguredInternalHookNames } from "./configured.js";
import {
  clearInternalHooks,
  getRegisteredEventKeys,
  triggerInternalHook,
  createInternalHookEvent,
  registerInternalHook,
  setInternalHooksEnabled,
} from "./internal-hooks.js";
import { loadInternalHooks } from "./loader.js";

describe("loader", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let tmpDir: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hooks-loader-"));
  });

  beforeEach(async () => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    // Create a temp directory for test modules
    tmpDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(tmpDir, { recursive: true });

    // Disable bundled hooks during tests by setting env var to non-existent directory
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_HOOKS_DIR"]);
    process.env.OPENCLAW_BUNDLED_HOOKS_DIR = "/nonexistent/bundled/hooks";
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    loggingState.rawConsole = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  async function writeDiscoveredHook(params: {
    sourceDir?: string;
    hookName: string;
    handlerCode?: string;
    events?: string[];
    exportName?: string;
    hookKey?: string;
  }): Promise<string> {
    const sourceDir = params.sourceDir ?? path.join(tmpDir, "hooks");
    const hookDir = path.join(sourceDir, params.hookName);
    await fs.mkdir(hookDir, { recursive: true });
    const events = params.events ?? ["command:new"];
    const metadata = {
      events,
      ...(params.exportName ? { export: params.exportName } : {}),
      ...(params.hookKey ? { hookKey: params.hookKey } : {}),
    };
    await fs.writeFile(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        `name: ${params.hookName}`,
        `description: ${params.hookName} test hook`,
        `metadata: ${JSON.stringify({ openclaw: metadata })}`,
        "---",
        "",
        `# ${params.hookName}`,
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(hookDir, "handler.js"),
      params.handlerCode ??
        `export default async function(event) { event.messages.push("${params.hookName}"); }\n`,
      "utf-8",
    );
    return hookDir;
  }

  function createEnabledHooksConfig(): OpenClawConfig {
    return { hooks: { internal: { enabled: true } } };
  }

  afterEach(async () => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    envSnapshot.restore();
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  describe("loadInternalHooks", () => {
    it("detects configured internal hook surfaces", () => {
      expect(hasConfiguredInternalHooks({} satisfies OpenClawConfig)).toBe(false);
      expect(
        hasConfiguredInternalHooks({
          hooks: { internal: { entries: { "session-memory": { enabled: true } } } },
        } satisfies OpenClawConfig),
      ).toBe(true);
      expect(
        hasConfiguredInternalHooks({
          hooks: { internal: { entries: { "session-memory": { enabled: false } } } },
        } satisfies OpenClawConfig),
      ).toBe(false);
      expect(
        hasConfiguredInternalHooks({
          hooks: { internal: { load: { extraDirs: ["/tmp/hooks"] } } },
        } satisfies OpenClawConfig),
      ).toBe(true);
      expect(
        resolveConfiguredInternalHookNames({
          hooks: { internal: { entries: { "session-memory": { enabled: true } } } },
        } satisfies OpenClawConfig),
      ).toEqual(new Set(["session-memory"]));
      expect(
        resolveConfiguredInternalHookNames({
          hooks: { internal: { enabled: true } },
        } satisfies OpenClawConfig),
      ).toBeNull();
    });

    const expectNoCommandHookRegistration = async (cfg: OpenClawConfig) => {
      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(getRegisteredEventKeys()).not.toContain("command:new");
    };

    it("should return 0 when hooks are explicitly disabled", async () => {
      const count = await loadInternalHooks(
        { hooks: { internal: { enabled: false } } } satisfies OpenClawConfig,
        tmpDir,
      );
      expect(count).toBe(0);
    });

    it("skips hook discovery until internal hooks are configured", async () => {
      for (const cfg of [
        {} satisfies OpenClawConfig,
        { hooks: {} } satisfies OpenClawConfig,
        { hooks: { internal: {} } } satisfies OpenClawConfig,
      ]) {
        const count = await loadInternalHooks(cfg, tmpDir);
        expect(count).toBe(0);
      }
    });

    it("loads only explicitly configured discovered hooks", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({ sourceDir: hooksDir, hookName: "keep-hook" });
      await writeDiscoveredHook({ sourceDir: hooksDir, hookName: "skip-hook" });

      const count = await loadInternalHooks(
        {
          hooks: {
            internal: {
              enabled: true,
              entries: {
                "keep-hook": { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        tmpDir,
        { managedHooksDir: hooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" },
      );

      expect(count).toBe(1);
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["keep-hook"]);
    });

    it("matches configured names against metadata hook keys", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({
        sourceDir: hooksDir,
        hookName: "display-name",
        hookKey: "metadata-key",
      });
      await writeDiscoveredHook({ sourceDir: hooksDir, hookName: "skip-hook" });

      const count = await loadInternalHooks(
        {
          hooks: {
            internal: {
              enabled: true,
              entries: { "metadata-key": { enabled: true } },
            },
          },
        },
        tmpDir,
        { managedHooksDir: hooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" },
      );

      expect(count).toBe(1);
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["display-name"]);
    });

    it("registers unknown event keys anyway (advisory warning, not a load failure)", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({
        sourceDir: hooksDir,
        hookName: "typo-hook",
        events: ["command:nwe", "command:new"],
      });

      const count = await loadInternalHooks(
        {
          hooks: {
            internal: {
              entries: {
                "typo-hook": { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        tmpDir,
        { managedHooksDir: hooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" },
      );

      // The typo'd key never fires, but validation is advisory: the hook still
      // loads and its valid subscriptions keep working.
      expect(count).toBe(1);
      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:nwe");
      expect(keys).toContain("command:new");
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["typo-hook"]);
    });

    it("preserves plugin-registered hooks when workspace hooks reload", async () => {
      const pluginHandler = vi.fn();
      registerInternalHook("gateway:startup", pluginHandler);

      const count = await loadInternalHooks(createEnabledHooksConfig(), tmpDir);

      expect(count).toBe(0);
      expect(getRegisteredEventKeys()).toContain("gateway:startup");

      await triggerInternalHook(createInternalHookEvent("gateway", "startup", "gateway:startup"));
      expect(pluginHandler).toHaveBeenCalledTimes(1);
    });

    it("replaces prior workspace hook registrations instead of duplicating them", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({
        sourceDir: hooksDir,
        hookName: "reloadable-hook",
      });
      const cfg = {
        hooks: {
          internal: {
            enabled: true,
            entries: { "reloadable-hook": { enabled: true } },
          },
        },
      } satisfies OpenClawConfig;
      const options = { managedHooksDir: hooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" };

      expect(await loadInternalHooks(cfg, tmpDir, options)).toBe(1);
      expect(await loadInternalHooks(cfg, tmpDir, options)).toBe(1);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(
        event.messages.reduce(
          (count, message) => count + (message === "reloadable-hook" ? 1 : 0),
          0,
        ),
      ).toBe(1);
    });

    it("should support named exports", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({
        sourceDir: hooksDir,
        hookName: "named-export",
        exportName: "myHandler",
        handlerCode: "export const myHandler = async function() {};\n",
      });
      const cfg = {
        hooks: {
          internal: {
            enabled: true,
            entries: { "named-export": { enabled: true } },
          },
        },
      } satisfies OpenClawConfig;

      const count = await loadInternalHooks(cfg, tmpDir, {
        managedHooksDir: hooksDir,
        bundledHooksDir: "/nonexistent/bundled/hooks",
      });
      expect(count).toBe(1);
    });

    it("should treat invalid handlers as non-loadable", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({
        sourceDir: hooksDir,
        hookName: "bad-export",
        handlerCode: 'export default "not a function";\n',
      });

      const count = await loadInternalHooks(
        {
          hooks: {
            internal: {
              enabled: true,
              entries: { "bad-export": { enabled: true } },
            },
          },
        },
        tmpDir,
        { managedHooksDir: hooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" },
      );
      expect(count).toBe(0);
    });

    it("keeps workspace hooks disabled by default until explicitly enabled", async () => {
      await writeDiscoveredHook({ hookName: "workspace-hook" });

      const disabledCount = await loadInternalHooks(createEnabledHooksConfig(), tmpDir);
      expect(disabledCount).toBe(0);
      expect(getRegisteredEventKeys()).not.toContain("command:new");

      const enabledCount = await loadInternalHooks(
        {
          hooks: {
            internal: {
              enabled: true,
              entries: {
                "workspace-hook": {
                  enabled: true,
                },
              },
            },
          },
        },
        tmpDir,
      );
      expect(enabledCount).toBe(1);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toContain("workspace-hook");
    });

    it("rejects directory hook handlers that escape hook dir via symlink", async () => {
      const outsideHandlerPath = path.join(fixtureRoot, `outside-handler-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const hookDir = path.join(tmpDir, "hooks", "symlink-hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(
        path.join(hookDir, "HOOK.md"),
        [
          "---",
          "name: symlink-hook",
          "description: symlink test",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
          "",
          "# Symlink Hook",
        ].join("\n"),
        "utf-8",
      );
      try {
        await fs.symlink(outsideHandlerPath, path.join(hookDir, "handler.js"));
      } catch {
        return;
      }

      await expectNoCommandHookRegistration(createEnabledHooksConfig());
    });

    it("rejects directory hook handlers that escape hook dir via hardlink", async () => {
      if (process.platform === "win32") {
        return;
      }
      const outsideHandlerPath = path.join(fixtureRoot, `outside-handler-hardlink-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const hookDir = path.join(tmpDir, "hooks", "hardlink-hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(
        path.join(hookDir, "HOOK.md"),
        [
          "---",
          "name: hardlink-hook",
          "description: hardlink test",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
          "",
          "# Hardlink Hook",
        ].join("\n"),
        "utf-8",
      );
      try {
        await fs.link(outsideHandlerPath, path.join(hookDir, "handler.js"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      await expectNoCommandHookRegistration(createEnabledHooksConfig());
    });

    it("keeps managed hooks active when a workspace hook reuses the same name", async () => {
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({
        sourceDir: managedHooksDir,
        hookName: "session-memory",
        handlerCode: 'export default async function(event) { event.messages.push("managed"); }\n',
      });
      await writeDiscoveredHook({
        hookName: "session-memory",
        handlerCode:
          'export default async function(event) { event.messages.push("workspace-override"); }\n',
      });

      const count = await loadInternalHooks(
        {
          hooks: {
            internal: {
              enabled: true,
              entries: {
                "session-memory": {
                  enabled: true,
                },
              },
            },
          },
        },
        tmpDir,
        { managedHooksDir },
      );
      expect(count).toBe(1);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toContain("managed");
      expect(event.messages).not.toContain("workspace-override");
    });
  });
});
