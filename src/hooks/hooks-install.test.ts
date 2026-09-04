// Hook installs must preserve discovery and execution across copied and linked layouts.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigForInstall } from "../cli/plugins-install-config.js";
import { tryInstallHookPackFromLocalPath } from "../cli/plugins-install-hook-fallback.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { pinConfigDir } from "../utils.js";
import { readHookInstalls } from "./installs.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

async function writeHook(hookDir: string, name: string): Promise<void> {
  await fs.mkdir(hookDir, { recursive: true });
  await fs.writeFile(
    path.join(hookDir, "HOOK.md"),
    [
      "---",
      `name: ${name}`,
      'description: "Test hook"',
      'metadata: {"openclaw":{"events":["command:new"]}}',
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(hookDir, "handler.js"),
    `export default async function(event) { event.messages.push(${JSON.stringify(name)}); }\n`,
    "utf-8",
  );
}

describe.each([
  { mode: "copied", link: false },
  { mode: "linked", link: true },
])("hooks install ($mode)", ({ link }) => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "hooks-install", layout: "split" });
    pinConfigDir();
    clearInternalHooks();
    await state.writeConfig({
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: { enabled: false },
    });
  });

  afterEach(async () => {
    try {
      const disabled = await prepareInternalHooks(
        { hooks: { internal: { enabled: false } } },
        state.workspaceDir,
      );
      disabled.commit();
      clearInternalHooks();
      setInternalHooksEnabled(true);
    } finally {
      await state.cleanup();
      pinConfigDir();
    }
  });

  it.each([
    { layout: "single hook", hookPath: ".", hookPackId: "hello-hook" },
    { layout: "conventional pack", hookPath: "./hooks/hello-hook", hookPackId: "hello-hooks" },
    { layout: "direct-child pack", hookPath: "./hello-hook", hookPackId: "hello-hooks" },
  ])(
    "discovers and triggers only installed hooks from a $layout",
    async ({ hookPath, hookPackId }) => {
      const sourceDir = state.path("sources", "hook-pack");
      await writeHook(path.resolve(sourceDir, hookPath), "hello-hook");
      await writeHook(state.path("sources", "adjacent-hook"), "adjacent-hook");
      if (hookPath !== ".") {
        await fs.writeFile(
          path.join(sourceDir, "package.json"),
          JSON.stringify({
            name: "@acme/hello-hooks",
            version: "0.0.0",
            openclaw: { hooks: [hookPath] },
          }),
          "utf-8",
        );
        // A package manifest selects its hooks; neither root nor nested siblings are implicit hooks.
        await writeHook(path.join(sourceDir, "unlisted-root"), "unlisted-root");
        await writeHook(path.join(sourceDir, "hooks", "unlisted-nested"), "unlisted-nested");
      }

      const snapshot = await loadConfigForInstall({
        rawSpec: sourceDir,
        normalizedSpec: sourceDir,
        resolvedPath: sourceDir,
      });
      const installResult = await tryInstallHookPackFromLocalPath({
        snapshot,
        resolvedPath: sourceDir,
        installMode: "install",
        safetyOverrides: { config: snapshot.config },
        link,
      });
      expect(installResult).toEqual({ ok: true });

      const installed = await readConfigFileSnapshot();
      expect(installed.valid).toBe(true);
      expect(installed.config.hooks?.internal).toMatchObject({
        enabled: true,
        entries: { "hello-hook": { enabled: true } },
      });
      expect(installed.config.hooks?.internal?.load?.extraDirs ?? []).toEqual(
        link ? [sourceDir] : [],
      );
      const installPath = link ? sourceDir : state.statePath("hooks", hookPackId);
      expect(readHookInstalls()).toEqual({
        [hookPackId]: expect.objectContaining({
          source: "path",
          sourcePath: sourceDir,
          installPath,
          hooks: ["hello-hook"],
        }),
      });
      await expect(
        fs.readFile(path.resolve(installPath, hookPath, "handler.js"), "utf-8"),
      ).resolves.toContain("hello-hook");

      const options = { bundledHooksDir: state.path("bundled-none") };
      const discovered = loadWorkspaceHookEntries(state.workspaceDir, {
        ...options,
        config: installed.config,
      });
      const prepared = await prepareInternalHooks(installed.config, state.workspaceDir, options);
      prepared.commit();
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect({
        discovered: discovered.map((entry) => entry.hook.name).toSorted(),
        loaded: prepared.loadedCount,
        messages: event.messages.toSorted(),
      }).toEqual({
        discovered: ["hello-hook"],
        loaded: 1,
        messages: ["hello-hook"],
      });
    },
  );
});
