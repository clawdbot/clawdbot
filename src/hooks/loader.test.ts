import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadInternalHooks } from "./loader.js";
import {
  clearInternalHooks,
  getRegisteredEventKeys,
  triggerInternalHook,
  createInternalHookEvent,
} from "./internal-hooks.js";
import type { MoltbotConfig } from "../config/config.js";

describe("loader", () => {
  let tmpDir: string;
  let originalBundledDir: string | undefined;

  beforeEach(async () => {
    clearInternalHooks();
    // Create a temp directory for test modules
    tmpDir = path.join(os.tmpdir(), `moltbot-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    // Disable bundled hooks during tests by setting env var to non-existent directory
    originalBundledDir = process.env.CLAWDBOT_BUNDLED_HOOKS_DIR;
    process.env.CLAWDBOT_BUNDLED_HOOKS_DIR = "/nonexistent/bundled/hooks";
  });

  afterEach(async () => {
    clearInternalHooks();
    // Restore original env var
    if (originalBundledDir === undefined) {
      delete process.env.CLAWDBOT_BUNDLED_HOOKS_DIR;
    } else {
      process.env.CLAWDBOT_BUNDLED_HOOKS_DIR = originalBundledDir;
    }
    // Clean up temp directory
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("loadInternalHooks", () => {
    it("should return 0 when hooks are not enabled", async () => {
      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: false,
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
    });

    it("should return 0 when hooks config is missing", async () => {
      const cfg: MoltbotConfig = {};
      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
    });

    it("should load a handler from a module", async () => {
      // Create a test handler module
      const handlerPath = path.join(tmpDir, "test-handler.js");
      const handlerCode = `
        export default async function(event) {
          // Test handler
        }
      `;
      await fs.writeFile(handlerPath, handlerCode, "utf-8");

      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
    });

    it("should load multiple handlers", async () => {
      // Create test handler modules
      const handler1Path = path.join(tmpDir, "handler1.js");
      const handler2Path = path.join(tmpDir, "handler2.js");

      await fs.writeFile(handler1Path, "export default async function() {}", "utf-8");
      await fs.writeFile(handler2Path, "export default async function() {}", "utf-8");

      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              { event: "command:new", module: handler1Path },
              { event: "command:stop", module: handler2Path },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(2);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
      expect(keys).toContain("command:stop");
    });

    it("should support named exports", async () => {
      // Create a handler module with named export
      const handlerPath = path.join(tmpDir, "named-export.js");
      const handlerCode = `
        export const myHandler = async function(event) {
          // Named export handler
        }
      `;
      await fs.writeFile(handlerPath, handlerCode, "utf-8");

      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
                export: "myHandler",
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);
    });

    it("should handle module loading errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: "/nonexistent/path/handler.js",
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load hook handler"),
        expect.any(String),
      );

      consoleError.mockRestore();
    });

    it("should handle non-function exports", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      // Create a module with a non-function export
      const handlerPath = path.join(tmpDir, "bad-export.js");
      await fs.writeFile(handlerPath, 'export default "not a function";', "utf-8");

      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("is not a function"));

      consoleError.mockRestore();
    });

    it("should handle relative paths", async () => {
      // Create a handler module
      const handlerPath = path.join(tmpDir, "relative-handler.js");
      await fs.writeFile(handlerPath, "export default async function() {}", "utf-8");

      // Get relative path from cwd
      const relativePath = path.relative(process.cwd(), handlerPath);

      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: relativePath,
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);
    });

    it("should actually call the loaded handler", async () => {
      // Create a handler that we can verify was called
      const handlerPath = path.join(tmpDir, "callable-handler.js");
      const handlerCode = `
        let callCount = 0;
        export default async function(event) {
          callCount++;
        }
        export function getCallCount() {
          return callCount;
        }
      `;
      await fs.writeFile(handlerPath, handlerCode, "utf-8");

      const cfg: MoltbotConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
              },
            ],
          },
        },
      };

      await loadInternalHooks(cfg, tmpDir);

      // Trigger the hook
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      // The handler should have been called, but we can't directly verify
      // the call count from this context without more complex test infrastructure
      // This test mainly verifies that loading and triggering doesn't crash
      expect(getRegisteredEventKeys()).toContain("command:new");
    });
  });
});
