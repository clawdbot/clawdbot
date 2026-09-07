// Hook loader tests cover loading bundled, workspace, and plugin hooks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { captureEnv } from "../test-utils/env.js";
import {
  clearInternalHooks,
  getRegisteredEventKeys,
  triggerInternalHook,
  createInternalHookEvent,
  registerInternalHook,
  setInternalHooksEnabled,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";
import type { OpenClawHookMetadata } from "./types.js";

async function commitPreparedHooks(...args: Parameters<typeof prepareInternalHooks>) {
  const prepared = await prepareInternalHooks(...args);
  prepared.commit();
  return prepared.loadedCount;
}

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
    requires?: OpenClawHookMetadata["requires"];
  }): Promise<string> {
    const sourceDir = params.sourceDir ?? path.join(tmpDir, "hooks");
    const hookDir = path.join(sourceDir, params.hookName);
    await fs.mkdir(hookDir, { recursive: true });
    const events = params.events ?? ["command:new"];
    const metadata = {
      events,
      ...(params.exportName ? { export: params.exportName } : {}),
      ...(params.hookKey ? { hookKey: params.hookKey } : {}),
      ...(params.requires ? { requires: params.requires } : {}),
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
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  describe("prepareInternalHooks", () => {
    const expectNoCommandHookRegistration = async (cfg: OpenClawConfig) => {
      const count = await commitPreparedHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(getRegisteredEventKeys()).not.toContain("command:new");
    };

    it("should return 0 when hooks are explicitly disabled", async () => {
      const count = await commitPreparedHooks(
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
        const count = await commitPreparedHooks(cfg, tmpDir);
        expect(count).toBe(0);
      }
    });

    it("loads only explicitly configured discovered hooks", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({ sourceDir: hooksDir, hookName: "keep-hook" });
      await writeDiscoveredHook({ sourceDir: hooksDir, hookName: "skip-hook" });

      const count = await commitPreparedHooks(
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

      const count = await commitPreparedHooks(
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

      const count = await commitPreparedHooks(
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

      const count = await commitPreparedHooks(createEnabledHooksConfig(), tmpDir);

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

      expect(await commitPreparedHooks(cfg, tmpDir, options)).toBe(1);
      expect(await commitPreparedHooks(cfg, tmpDir, options)).toBe(1);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(
        event.messages.reduce(
          (count, message) => count + (message === "reloadable-hook" ? 1 : 0),
          0,
        ),
      ).toBe(1);
    });

    it.each([
      ["invalid export", 'export default "not a function";'],
      ["failed import", 'throw new Error("candidate import failed");'],
    ])("retains the committed hook generation after %s", async (_name, handlerCode) => {
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "original" });
      const options = { managedHooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" };
      const config = (names: string[]): OpenClawConfig => ({
        hooks: {
          internal: { entries: Object.fromEntries(names.map((name) => [name, { enabled: true }])) },
        },
      });
      await commitPreparedHooks(config(["original"]), tmpDir, options);
      await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "replacement" });
      await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "broken", handlerCode });

      await expect(
        commitPreparedHooks(config(["replacement", "broken"]), tmpDir, options),
      ).rejects.toThrow();

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["original"]);
    });

    it("keeps committed hooks serving while replacement imports are pending", async () => {
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      const options = { managedHooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" };
      await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "original" });
      await commitPreparedHooks(createEnabledHooksConfig(), tmpDir, options);
      const importStarted = createDeferredCore();
      const releaseImport = createDeferredCore();
      vi.stubGlobal("openclawHookImportGate", {
        started: importStarted.resolve,
        wait: releaseImport.promise,
      });
      await writeDiscoveredHook({
        sourceDir: managedHooksDir,
        hookName: "replacement",
        handlerCode:
          'globalThis.openclawHookImportGate.started(); await globalThis.openclawHookImportGate.wait; export default async function(event) { event.messages.push("replacement"); }',
      });
      const loading = prepareInternalHooks(
        {
          hooks: { internal: { entries: { replacement: { enabled: true } } } },
        },
        tmpDir,
        options,
      );
      try {
        await importStarted.promise;
        const event = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(event);
        expect(event.messages).toEqual(["original"]);
      } finally {
        releaseImport.resolve();
        await loading;
      }
      const prepared = await loading;
      const beforeCommit = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(beforeCommit);
      expect(beforeCommit.messages).toEqual(["original"]);
      prepared.commit();
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["replacement"]);
    });

    it.each(["missing", "outside hook directory"])(
      "retains active handlers when a selected handler becomes %s before sibling reload",
      async (failure) => {
        const managedHooksDir = path.join(tmpDir, "managed-hooks");
        const options = { managedHooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" };
        const hookDir = await writeDiscoveredHook({
          sourceDir: managedHooksDir,
          hookName: "original",
        });
        const config: OpenClawConfig = {
          hooks: { internal: { entries: { original: { enabled: true } } } },
        };
        await commitPreparedHooks(config, tmpDir, options);
        const initial = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(initial);
        expect(initial.messages).toEqual(["original"]);

        const handlerPath = path.join(hookDir, "handler.js");
        await fs.unlink(handlerPath);
        if (failure === "outside hook directory") {
          const outside = path.join(tmpDir, "outside.js");
          await fs.writeFile(outside, "export default async function() {}\n");
          await fs.symlink(outside, handlerPath);
        }
        await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "sibling" });
        await expect(
          commitPreparedHooks(
            {
              hooks: {
                internal: {
                  entries: { original: { enabled: true }, sibling: { enabled: true } },
                },
              },
            },
            tmpDir,
            options,
          ),
        ).rejects.toThrow();
        const after = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(after);
        expect(after.messages).toEqual(["original"]);
      },
    );

    it.each([
      "directory",
      "descriptor",
      "oversized metadata",
      "invalid metadata",
      "invalid keyed metadata",
    ])(
      "retains active handlers when its configured source loses %s before sibling reload",
      async (failure) => {
        const extraDir = path.join(tmpDir, "extra-hooks");
        const original = await writeDiscoveredHook({
          sourceDir: extraDir,
          hookName: "original",
          hookKey: "selected-name",
        });
        const options = {
          managedHooksDir:
            failure === "invalid keyed metadata" ? extraDir : path.join(tmpDir, "managed-none"),
        };
        const config: OpenClawConfig = {
          hooks: {
            internal: {
              load: { extraDirs: failure === "invalid keyed metadata" ? [] : [extraDir] },
              entries: { "selected-name": { enabled: true } },
            },
          },
        };
        await commitPreparedHooks(config, tmpDir, options);
        const initial = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(initial);
        expect(initial.messages).toEqual(["original"]);

        if (failure === "directory") {
          await fs.rm(original, { recursive: true });
        } else if (failure === "descriptor") {
          await fs.unlink(path.join(original, "HOOK.md"));
        } else {
          await fs.writeFile(
            path.join(original, "HOOK.md"),
            failure === "oversized metadata"
              ? "x".repeat(1024 * 1024 + 1)
              : "---\nname: original\nmetadata: {invalid\n---\n",
          );
        }
        await writeDiscoveredHook({ sourceDir: extraDir, hookName: "sibling" });
        await expect(commitPreparedHooks(config, tmpDir, options)).rejects.toThrow();
        const after = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(after);
        expect(after.messages).toEqual(["original"]);
      },
    );

    it.each(["disabled", "ineligible", "unselected", "collision loser"])(
      "ignores a missing handler for a %s during atomic reload",
      async (selection) => {
        const managedHooksDir = path.join(tmpDir, "managed-hooks");
        const options = { managedHooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" };
        await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "valid" });
        const broken = await writeDiscoveredHook({
          sourceDir: selection === "collision loser" ? undefined : managedHooksDir,
          hookName: selection === "collision loser" ? "valid" : "broken",
          requires: selection === "ineligible" ? { config: ["browser.enabled"] } : undefined,
        });
        await fs.unlink(path.join(broken, "handler.js"));

        await expect(
          commitPreparedHooks(
            {
              browser: { enabled: false },
              hooks: {
                internal: {
                  entries: {
                    valid: { enabled: true },
                    ...(selection === "disabled" ? { broken: { enabled: false } } : {}),
                    ...(selection === "ineligible" ? { broken: { enabled: true } } : {}),
                  },
                },
              },
            },
            tmpDir,
            options,
          ),
        ).resolves.toBe(1);
        const event = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(event);
        expect(event.messages).toEqual(["valid"]);
      },
    );

    it.each(
      ["ineligible", "disabled", "unselected"].flatMap((selection) =>
        ["handler", "directory"].map((failure) => ({ selection, failure })),
      ),
    )(
      "does not activate a shadowed hook when its $selection override loses its $failure",
      async ({ selection, failure }) => {
        const bundledHooksDir = path.join(tmpDir, "bundled-hooks");
        const managedHooksDir = path.join(tmpDir, "managed-hooks");
        const options = { bundledHooksDir, managedHooksDir };
        await writeDiscoveredHook({
          sourceDir: bundledHooksDir,
          hookName: "overridden",
          hookKey: "bundled-selection",
          handlerCode: 'export default async function(event) { event.messages.push("bundled"); }',
        });
        const overriding = await writeDiscoveredHook({
          sourceDir: managedHooksDir,
          hookName: "overridden",
          hookKey: "managed-selection",
          requires: selection === "ineligible" ? { config: ["browser.enabled"] } : undefined,
        });
        const entries = {
          "bundled-selection": { enabled: true },
          ...(selection !== "unselected"
            ? { "managed-selection": { enabled: selection !== "disabled" } }
            : {}),
        };
        const config: OpenClawConfig = {
          browser: { enabled: false },
          hooks: { internal: { entries } },
        };
        await expect(commitPreparedHooks(config, tmpDir, options)).resolves.toBe(0);
        const initial = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(initial);
        expect(initial.messages).toEqual([]);

        if (failure === "directory") {
          await fs.rm(overriding, { recursive: true });
        } else {
          await fs.unlink(path.join(overriding, "handler.js"));
        }
        await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "sibling" });
        await commitPreparedHooks(
          {
            ...config,
            hooks: { internal: { entries: { ...entries, sibling: { enabled: true } } } },
          },
          tmpDir,
          options,
        );
        const after = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(after);
        expect(after.messages).toEqual(["sibling"]);
      },
    );

    it("allows a valid higher-precedence source to replace a lost selected source", async () => {
      const bundledHooksDir = path.join(tmpDir, "bundled-hooks");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      const original = await writeDiscoveredHook({
        sourceDir: bundledHooksDir,
        hookName: "original",
      });
      const options = { bundledHooksDir, managedHooksDir };
      const config = createEnabledHooksConfig();
      await commitPreparedHooks(config, tmpDir, options);
      await fs.rm(original, { recursive: true });
      await writeDiscoveredHook({
        sourceDir: managedHooksDir,
        hookName: "original",
        handlerCode: 'export default async function(event) { event.messages.push("replacement"); }',
      });
      await commitPreparedHooks(config, tmpDir, options);
      const after = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(after);
      expect(after.messages).toEqual(["replacement"]);
    });

    it.each(["disable", "ineligible", "name removal", "root removal", "install removal"])(
      "accepts intentional %s after a winning source disappears",
      async (removal) => {
        const bundledHooksDir = path.join(tmpDir, "bundled-hooks");
        const managedHooksDir = path.join(tmpDir, "managed-hooks");
        const extraDir = path.join(tmpDir, "extra-hooks");
        const options = { bundledHooksDir, managedHooksDir };
        await writeDiscoveredHook({
          sourceDir: bundledHooksDir,
          hookName: "original",
          hookKey: "lower-name",
          handlerCode: 'export default async function(event) { event.messages.push("lower"); }',
        });
        const original = await writeDiscoveredHook({
          sourceDir: extraDir,
          hookName: "original",
          hookKey: "selected-name",
          requires: { config: ["browser.enabled"] },
        });
        const config: OpenClawConfig = {
          browser: { enabled: true },
          hooks: {
            internal: {
              load: { extraDirs: [extraDir] },
              entries: {
                "lower-name": { enabled: true },
                ...(removal === "install removal" ? {} : { "selected-name": { enabled: true } }),
              },
            },
          },
        };
        const state = await import("../state/config-machine-state.js");
        const installed = vi.spyOn(state, "readConfigMachineState");
        installed.mockReturnValue(
          removal === "install removal"
            ? { pack: { source: "path", hooks: ["selected-name"] } }
            : undefined,
        );
        try {
          await commitPreparedHooks(config, tmpDir, options);
          await fs.rm(original, { recursive: true });
          await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "sibling" });
          const entries: Record<string, { enabled?: boolean }> = {
            ...config.hooks?.internal?.entries,
            sibling: { enabled: true },
          };
          if (removal === "disable") {
            entries["selected-name"] = { enabled: false };
          }
          if (removal === "name removal") {
            delete entries["selected-name"];
          }
          if (removal === "install removal") {
            installed.mockReturnValue(undefined);
          }
          const next: OpenClawConfig = {
            ...config,
            browser: { enabled: removal !== "ineligible" },
            hooks: {
              internal: {
                entries,
                load: { extraDirs: removal === "root removal" ? [] : [extraDir] },
              },
            },
          };
          await commitPreparedHooks(next, tmpDir, options);
          const after = createInternalHookEvent("command", "new", "test-session");
          await triggerInternalHook(after);
          expect(after.messages).toEqual(
            removal === "disable" || removal === "ineligible" ? ["sibling"] : ["lower", "sibling"],
          );
        } finally {
          installed.mockRestore();
        }
      },
    );

    it("drops a lost workspace source when the selected workspace changes", async () => {
      const original = await writeDiscoveredHook({ hookName: "original" });
      const config: OpenClawConfig = {
        hooks: { internal: { entries: { original: { enabled: true } } } },
      };
      await commitPreparedHooks(config, tmpDir);
      await fs.rm(original, { recursive: true });
      const nextWorkspace = path.join(tmpDir, "new-workspace");
      await writeDiscoveredHook({
        sourceDir: path.join(nextWorkspace, "hooks"),
        hookName: "original",
        handlerCode:
          'export default async function(event) { event.messages.push("new-workspace"); }',
      });
      await commitPreparedHooks(config, nextWorkspace);
      const after = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(after);
      expect(after.messages).toEqual(["new-workspace"]);
    });

    it("keeps best-effort startup's intact lower-priority hook after discovery rejection", async () => {
      const bundledHooksDir = path.join(tmpDir, "bundled-hooks");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({ sourceDir: bundledHooksDir, hookName: "original" });
      const broken = await writeDiscoveredHook({
        sourceDir: managedHooksDir,
        hookName: "original",
      });
      await fs.unlink(path.join(broken, "handler.js"));

      await expect(
        commitPreparedHooks(createEnabledHooksConfig(), tmpDir, {
          managedHooksDir,
          bundledHooksDir,
          failureMode: "best-effort",
        }),
      ).resolves.toBe(1);
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["original"]);
    });

    it("commits disable and re-enable for registered internal hook listeners", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);
      const disabled = await prepareInternalHooks(
        { hooks: { internal: { enabled: false } } },
        tmpDir,
      );
      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
      expect(handler).toHaveBeenCalledTimes(1);
      disabled.commit();
      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
      expect(handler).toHaveBeenCalledTimes(1);

      const enabled = await prepareInternalHooks(createEnabledHooksConfig(), tmpDir);
      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
      expect(handler).toHaveBeenCalledTimes(1);
      enabled.commit();
      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it.each(["before preparation", "after preparation", "after shutdown"])(
      "keeps deferred startup from overwriting ownership transferred %s",
      async (transfer) => {
        await drainGlobalSingletonLifecycleState("restart");
        const handler = vi.fn();
        registerInternalHook("command:new", handler);
        const disable = () =>
          commitPreparedHooks({ hooks: { internal: { enabled: false } } }, tmpDir);
        if (transfer === "before preparation") {
          await disable();
        }
        const startup = await prepareInternalHooks(createEnabledHooksConfig(), tmpDir);
        if (transfer === "after preparation") {
          await disable();
        } else if (transfer === "after shutdown") {
          await drainGlobalSingletonLifecycleState("restart");
          await disable();
        }

        expect(startup.commit({ initial: true })).toBe(false);
        await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));
        expect(handler).not.toHaveBeenCalled();
      },
    );

    it.each(["replacement", "disable"])(
      "finishes an admitted event's original handlers across %s",
      async (change) => {
        const managedHooksDir = path.join(tmpDir, "managed-hooks");
        const options = { managedHooksDir, bundledHooksDir: "/nonexistent/bundled/hooks" };
        const started = createDeferredCore();
        const release = createDeferredCore();
        registerInternalHook("command", async () => {
          started.resolve();
          await release.promise;
        });
        await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "original" });
        await commitPreparedHooks(createEnabledHooksConfig(), tmpDir, options);
        const originalEvent = createInternalHookEvent("command", "new", "test-session");
        const dispatch = triggerInternalHook(originalEvent);
        try {
          await started.promise;
          await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "replacement" });
          await commitPreparedHooks(
            {
              hooks: {
                internal: {
                  enabled: change !== "disable",
                  entries: { replacement: { enabled: true } },
                },
              },
            },
            tmpDir,
            options,
          );
        } finally {
          release.resolve();
          await dispatch;
        }
        expect(originalEvent.messages).toEqual(["original"]);
        const nextEvent = createInternalHookEvent("command", "new", "test-session");
        await triggerInternalHook(nextEvent);
        expect(nextEvent.messages).toEqual(change === "disable" ? [] : ["replacement"]);
      },
    );

    it("keeps configured hooks across plugin cleanup and retires them on Gateway restart", async () => {
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({ sourceDir: managedHooksDir, hookName: "managed" });
      await commitPreparedHooks(createEnabledHooksConfig(), tmpDir, { managedHooksDir });
      const unrelated = vi.fn();
      registerInternalHook("command:new", unrelated);

      await drainGlobalSingletonLifecycleState("plugin-registry");
      const afterPluginCleanup = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(afterPluginCleanup);
      expect(afterPluginCleanup.messages).toEqual(["managed"]);
      expect(unrelated).toHaveBeenCalledTimes(1);

      await drainGlobalSingletonLifecycleState("restart");
      const afterRestart = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(afterRestart);
      expect(afterRestart.messages).toEqual([]);
      expect(unrelated).toHaveBeenCalledTimes(2);
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

      const count = await commitPreparedHooks(cfg, tmpDir, {
        managedHooksDir: hooksDir,
        bundledHooksDir: "/nonexistent/bundled/hooks",
      });
      expect(count).toBe(1);
    });

    it("skips invalid handlers while preserving valid siblings during best-effort startup", async () => {
      const hooksDir = path.join(tmpDir, "managed-hooks");
      await writeDiscoveredHook({
        sourceDir: hooksDir,
        hookName: "bad-export",
        handlerCode: 'export default "not a function";\n',
      });

      await writeDiscoveredHook({ sourceDir: hooksDir, hookName: "valid" });
      const count = await commitPreparedHooks(
        {
          hooks: {
            internal: {
              enabled: true,
              entries: { "bad-export": { enabled: true }, valid: { enabled: true } },
            },
          },
        },
        tmpDir,
        {
          managedHooksDir: hooksDir,
          bundledHooksDir: "/nonexistent/bundled/hooks",
          failureMode: "best-effort",
        },
      );
      expect(count).toBe(1);
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["valid"]);
    });

    it("keeps workspace hooks disabled by default until explicitly enabled", async () => {
      await writeDiscoveredHook({ hookName: "workspace-hook" });

      const disabledCount = await commitPreparedHooks(createEnabledHooksConfig(), tmpDir);
      expect(disabledCount).toBe(0);
      expect(getRegisteredEventKeys()).not.toContain("command:new");

      const enabledCount = await commitPreparedHooks(
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

      const count = await commitPreparedHooks(
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
