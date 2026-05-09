import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { stripAnsi } from "../terminal/ansi.js";
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
  }): Promise<string> {
    const sourceDir = params.sourceDir ?? path.join(tmpDir, "hooks");
    const hookDir = path.join(sourceDir, params.hookName);
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        `name: ${params.hookName}`,
        `description: ${params.hookName} test hook`,
        'metadata: {"openclaw":{"events":["command:new"]}}',
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

  async function writeHandlerModule(
    fileName: string,
    code = "export default async function() {}",
  ): Promise<string> {
    const handlerPath = path.join(tmpDir, fileName);
    await fs.writeFile(handlerPath, code, "utf-8");
    return handlerPath;
  }

  function withLegacyInternalHookHandlers(
    config: OpenClawConfig,
    handlers?: Array<{ event: string; module: string; export?: string }>,
  ): OpenClawConfig {
    if (!handlers) {
      return config;
    }
    return {
      ...config,
      hooks: {
        ...config.hooks,
        internal: {
          ...config.hooks?.internal,
          handlers,
        },
      },
    } as OpenClawConfig;
  }

  function createEnabledHooksConfig(
    handlers?: Array<{ event: string; module: string; export?: string }>,
  ): OpenClawConfig {
    return withLegacyInternalHookHandlers(
      {
        hooks: {
          internal: { enabled: true },
        },
      },
      handlers,
    );
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
      expect(
        resolveConfiguredInternalHookNames({
          hooks: { internal: { installs: { pack: { source: "path" } } } },
        } satisfies OpenClawConfig),
      ).toBeNull();
    });

    const createLegacyHandlerConfig = () =>
      createEnabledHooksConfig([
        {
          event: "command:new",
          module: "legacy-handler.js",
        },
      ]);

    const expectNoCommandHookRegistration = async (cfg: OpenClawConfig) => {
      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(getRegisteredEventKeys()).not.toContain("command:new");
    };

    it("should return 0 when hooks are explicitly disabled", async () => {
      for (const cfg of [
        {
          hooks: {
            internal: {
              enabled: false,
            },
          },
        } satisfies OpenClawConfig,
        withLegacyInternalHookHandlers(
          {
            hooks: {
              internal: {
                enabled: false,
              },
            },
          } satisfies OpenClawConfig,
          [],
        ),
      ]) {
        const count = await loadInternalHooks(cfg, tmpDir);
        expect(count).toBe(0);
      }
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

    it("should load multiple handlers", async () => {
      // Create test handler modules
      const handler1Path = await writeHandlerModule("handler1.js");
      const handler2Path = await writeHandlerModule("handler2.js");

      const cfg = createEnabledHooksConfig([
        { event: "command:new", module: path.basename(handler1Path) },
        { event: "command:stop", module: path.basename(handler2Path) },
      ]);

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(2);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
      expect(keys).toContain("command:stop");
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
      await writeHandlerModule(
        "legacy-handler.js",
        'export default async function(event) { event.messages.push("reloadable-hook"); }\n',
      );

      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: "legacy-handler.js",
        },
      ]);

      expect(await loadInternalHooks(cfg, tmpDir)).toBe(1);
      expect(await loadInternalHooks(cfg, tmpDir)).toBe(1);

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
      // Create a handler module with named export
      const handlerCode = `
        export const myHandler = async function(event) {
          // Named export handler
        }
      `;
      const handlerPath = await writeHandlerModule("named-export.js", handlerCode);

      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: path.basename(handlerPath),
          export: "myHandler",
        },
      ]);

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);
    });

    it("should treat invalid handlers as non-loadable", async () => {
      const badExportPath = await writeHandlerModule(
        "bad-export.js",
        'export default "not a function";',
      );

      for (const cfg of [
        createEnabledHooksConfig([
          {
            event: "command:new",
            module: "missing-handler.js",
          },
        ]),
        createEnabledHooksConfig([
          {
            event: "command:new",
            module: path.basename(badExportPath),
          },
        ]),
      ]) {
        const count = await loadInternalHooks(cfg, tmpDir);
        expect(count).toBe(0);
      }
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

    it("rejects legacy handler modules that escape workspace via symlink", async () => {
      const outsideHandlerPath = path.join(fixtureRoot, `outside-legacy-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const linkedHandlerPath = path.join(tmpDir, "legacy-handler.js");
      try {
        await fs.symlink(outsideHandlerPath, linkedHandlerPath);
      } catch {
        return;
      }

      await expectNoCommandHookRegistration(createLegacyHandlerConfig());
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

    it("rejects legacy handler modules that escape workspace via hardlink", async () => {
      if (process.platform === "win32") {
        return;
      }
      const outsideHandlerPath = path.join(fixtureRoot, `outside-legacy-hardlink-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const linkedHandlerPath = path.join(tmpDir, "legacy-handler.js");
      try {
        await fs.link(outsideHandlerPath, linkedHandlerPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      await expectNoCommandHookRegistration(createLegacyHandlerConfig());
    });

    it("sanitizes control characters in loader error logs", async () => {
      const error = loggingState.rawConsole?.error;
      expect(error).toBeTypeOf("function");

      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: `${tmpDir}\u001b[31m\nforged-log`,
        },
      ]);

      await expectNoCommandHookRegistration(cfg);

      const messages = stripAnsi(
        (error as ReturnType<typeof vi.fn>).mock.calls
          .map((call) => String(call[0] ?? ""))
          .join("\n"),
      );
      expect(messages).toContain("forged-log");
      expect(messages).not.toContain("\u001b[31m");
      expect(messages).not.toContain("\nforged-log");
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
