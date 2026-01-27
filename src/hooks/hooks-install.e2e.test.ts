import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hooks-e2e-"));
  tempDirs.push(dir);
  return dir;
}

describe("hooks install (e2e)", () => {
  let prevStateDir: string | undefined;
  let prevBundledDir: string | undefined;
  let workspaceDir: string;

  beforeEach(async () => {
    const baseDir = await makeTempDir();
    workspaceDir = path.join(baseDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    prevBundledDir = process.env.CLAWDBOT_BUNDLED_HOOKS_DIR;
    process.env.CLAWDBOT_STATE_DIR = path.join(baseDir, "state");
    process.env.CLAWDBOT_BUNDLED_HOOKS_DIR = path.join(baseDir, "bundled-none");
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevStateDir === undefined) {
      delete process.env.CLAWDBOT_STATE_DIR;
    } else {
      process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    }

    if (prevBundledDir === undefined) {
      delete process.env.CLAWDBOT_BUNDLED_HOOKS_DIR;
    } else {
      process.env.CLAWDBOT_BUNDLED_HOOKS_DIR = prevBundledDir;
    }

    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });

  it("installs a hook pack and triggers the handler", async () => {
    const baseDir = await makeTempDir();
    const packDir = path.join(baseDir, "hook-pack");
    const hookDir = path.join(packDir, "hooks", "hello-hook");
    await fs.mkdir(hookDir, { recursive: true });

    await fs.writeFile(
      path.join(packDir, "package.json"),
      JSON.stringify(
        {
          name: "@acme/hello-hooks",
          version: "0.0.0",
          moltbot: { hooks: ["./hooks/hello-hook"] },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await fs.writeFile(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        'name: "hello-hook"',
        'description: "Test hook"',
        'metadata: {"moltbot":{"events":["command:new"]}}',
        "---",
        "",
        "# Hello Hook",
        "",
      ].join("\n"),
      "utf-8",
    );

    await fs.writeFile(
      path.join(hookDir, "handler.js"),
      "export default async function(event) { event.messages.push('hook-ok'); }\n",
      "utf-8",
    );

    const { installHooksFromPath } = await import("./install.js");
    const installResult = await installHooksFromPath({ path: packDir });
    expect(installResult.ok).toBe(true);
    if (!installResult.ok) return;

    const { clearInternalHooks, createInternalHookEvent, triggerInternalHook } =
      await import("./internal-hooks.js");
    const { loadInternalHooks } = await import("./loader.js");

    clearInternalHooks();
    const loaded = await loadInternalHooks(
      { hooks: { internal: { enabled: true } } },
      workspaceDir,
    );
    expect(loaded).toBe(1);

    const event = createInternalHookEvent("command", "new", "test-session");
    await triggerInternalHook(event);
    expect(event.messages).toContain("hook-ok");
  });
});
