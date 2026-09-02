import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSON5 from "json5";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installHooksFromPath } from "./install.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "./internal-hooks.js";
import { loadInternalHooks } from "./loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hookName = "qa-lifecycle-recorder";
const hookMarker = "QA_HOOK_LIFECYCLE_OK";

afterEach(() => {
  clearInternalHooks();
});

async function runHooksCli(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await execFileAsync(process.execPath, ["openclaw.mjs", "hooks", ...args], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 90_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${failed.message}\nstdout:\n${failed.stdout ?? ""}\nstderr:\n${failed.stderr ?? ""}`,
      { cause: error },
    );
  }
}

async function readConfig(configPath: string): Promise<OpenClawConfig> {
  return JSON5.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
}

async function createHookPackFixture() {
  const rootDir = tempDirs.make("openclaw-hooks-lifecycle-e2e-");
  const homeDir = path.join(rootDir, "home");
  const stateDir = path.join(rootDir, "state");
  const workspaceDir = path.join(rootDir, "workspace");
  const managedHooksDir = path.join(stateDir, "hooks");
  const bundledHooksDir = path.join(rootDir, "bundled-hooks");
  const packageRoot = path.join(rootDir, "archive-root");
  const packageDir = path.join(packageRoot, "package");
  const hookDir = path.join(packageDir, "hooks", hookName);
  const archivePath = path.join(rootDir, "qa-lifecycle-hooks.tgz");
  const configPath = path.join(stateDir, "openclaw.json");

  await Promise.all([
    fs.mkdir(homeDir, { recursive: true }),
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(workspaceDir, { recursive: true }),
    fs.mkdir(bundledHooksDir, { recursive: true }),
    fs.mkdir(hookDir, { recursive: true }),
  ]);

  const initialConfig: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    hooks: { internal: { enabled: true } },
  };
  await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/qa-lifecycle-hooks",
        version: "1.0.0",
        openclaw: { hooks: [`./hooks/${hookName}`] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(hookDir, "HOOK.md"),
    [
      "---",
      `name: ${hookName}`,
      "description: Records a Gateway startup lifecycle event",
      'metadata: {"openclaw":{"events":["gateway:startup"]}}',
      "---",
      "",
      "# QA lifecycle recorder",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(hookDir, "handler.js"),
    `export default async function recordLifecycle(event) { event.messages.push("${hookMarker}"); }\n`,
    "utf8",
  );
  await tar.c({ cwd: packageRoot, file: archivePath, gzip: true }, ["package"]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
    VITEST: "",
  };

  return {
    archivePath,
    bundledHooksDir,
    configPath,
    env,
    initialConfig,
    managedHooksDir,
    workspaceDir,
  };
}

describe("internal hook lifecycle", () => {
  it("installs, discovers, toggles, and dispatches an authored hook pack", async () => {
    const fixture = await createHookPackFixture();
    const install = await installHooksFromPath({
      config: fixture.initialConfig,
      hooksDir: fixture.managedHooksDir,
      path: fixture.archivePath,
    });
    expect(install).toMatchObject({
      ok: true,
      hookPackId: "qa-lifecycle-hooks",
      hooks: [hookName],
      packageKind: "hook-only",
    });
    if (!install.ok) {
      throw new Error(install.error);
    }

    await expect(
      fs.readFile(path.join(install.targetDir, "hooks", hookName, "HOOK.md"), "utf8"),
    ).resolves.toContain("gateway:startup");

    const discovered = loadWorkspaceHookEntries(fixture.workspaceDir, {
      bundledHooksDir: fixture.bundledHooksDir,
      config: fixture.initialConfig,
      managedHooksDir: fixture.managedHooksDir,
    });
    expect(discovered).toEqual([
      expect.objectContaining({
        hook: expect.objectContaining({
          name: hookName,
          source: "openclaw-managed",
        }),
        metadata: expect.objectContaining({
          events: ["gateway:startup"],
        }),
      }),
    ]);

    const disabled = await runHooksCli(["disable", hookName], fixture.env);
    expect(disabled.stdout).toContain(hookName);
    const disabledConfig = await readConfig(fixture.configPath);
    expect(disabledConfig.hooks?.internal?.entries?.[hookName]?.enabled).toBe(false);

    clearInternalHooks();
    expect(
      await loadInternalHooks(disabledConfig, fixture.workspaceDir, {
        bundledHooksDir: fixture.bundledHooksDir,
        managedHooksDir: fixture.managedHooksDir,
      }),
    ).toBe(0);
    const disabledEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
      cfg: disabledConfig,
      workspaceDir: fixture.workspaceDir,
    });
    await triggerInternalHook(disabledEvent);
    expect(disabledEvent.messages).not.toContain(hookMarker);

    const enabled = await runHooksCli(["enable", hookName], fixture.env);
    expect(enabled.stdout).toContain(hookName);
    const enabledConfig = await readConfig(fixture.configPath);
    expect(enabledConfig.hooks?.internal?.entries?.[hookName]?.enabled).toBe(true);

    clearInternalHooks();
    expect(
      await loadInternalHooks(enabledConfig, fixture.workspaceDir, {
        bundledHooksDir: fixture.bundledHooksDir,
        managedHooksDir: fixture.managedHooksDir,
      }),
    ).toBe(1);
    const event = createInternalHookEvent("gateway", "startup", "gateway:startup", {
      cfg: enabledConfig,
      workspaceDir: fixture.workspaceDir,
    });
    await triggerInternalHook(event);
    expect(event.messages).toContain(hookMarker);
  }, 180_000);
});
