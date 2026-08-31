import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginInstallPreflight } from "../cli/plugins-install-preflight.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { installPluginFromGitSpec } from "./git-install.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";

describe("git install target ownership", () => {
  let state: OpenClawTestState;
  let sourceDir: string;
  let spec: string;

  async function git(cwd: string, ...args: string[]) {
    const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 10_000 });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  async function commitPlugin(pluginId: string, version: string) {
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ name: "git-fixture", version, openclaw: { extensions: ["index.js"] } }),
    );
    await fs.writeFile(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify({ id: pluginId, configSchema: { type: "object", properties: {} } }),
    );
    await fs.writeFile(
      path.join(sourceDir, "index.js"),
      `export default ${JSON.stringify(version)};\n`,
    );
    await git(sourceDir, "add", ".");
    await git(sourceDir, "-c", "commit.gpgsign=false", "commit", "-m", version);
    return await git(sourceDir, "rev-parse", "HEAD");
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "git-install-target" });
    const globalConfig = await state.writeText("global-npmrc", "");
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", globalConfig);
    sourceDir = state.path("source");
    await fs.mkdir(sourceDir);
    await git(sourceDir, "init", "--initial-branch=main");
    await git(sourceDir, "config", "user.name", "OpenClaw Test");
    await git(sourceDir, "config", "user.email", "test@openclaw.invalid");
    await commitPlugin("demo", "1.0.0");
    spec = `git:${pathToFileURL(sourceDir).href}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it.each([
    { pluginId: "demo", deferred: false },
    { pluginId: "renamed-demo", deferred: false },
    { pluginId: "demo", deferred: true },
    { pluginId: "renamed-demo", deferred: true },
  ])(
    "refuses a reinstall with id=$pluginId and deferred=$deferred",
    async ({ pluginId, deferred }) => {
      const installed = await installPluginFromGitSpec({ spec });
      if (!installed.ok) {
        throw new Error(installed.error);
      }
      const markerPath = path.join(installed.targetDir, "operator-note.txt");
      await fs.writeFile(markerPath, "keep this checkout");
      await commitPlugin(pluginId, "2.0.0");

      const options = { spec, mode: "install" as const };
      const result = await installPluginFromGitSpec(
        deferred ? requestDeferredPluginInstall(options) : options,
      );
      // Settle any pre-fix transaction so the failing reproduction leaves no backup behind.
      await resolvePluginInstallTransaction(result)?.commit();
      expect.soft(result).toEqual({
        ok: false,
        error: `plugin already exists: ${installed.targetDir} (delete it first)`,
      });
      expect.soft(await git(installed.targetDir, "rev-parse", "HEAD")).toBe(installed.git.commit);
      await expect.soft(fs.readFile(markerPath, "utf8")).resolves.toBe("keep this checkout");
      await expect
        .soft(fs.readFile(path.join(installed.targetDir, "openclaw.plugin.json"), "utf8"))
        .resolves.toContain('"id":"demo"');
    },
  );

  it("refuses default and dry-run reinstalls but allows an explicit force replacement", async () => {
    const installed = await installPluginFromGitSpec({ spec });
    if (!installed.ok) {
      throw new Error(installed.error);
    }
    const nextCommit = await commitPlugin("demo", "2.0.0");
    const refusal = {
      ok: false,
      error: `plugin already exists: ${installed.targetDir} (delete it first)`,
    };
    expect(await installPluginFromGitSpec({ spec })).toEqual(refusal);
    expect(await installPluginFromGitSpec({ spec, dryRun: true })).toEqual(refusal);

    const preflight = await resolvePluginInstallPreflight({
      raw: spec,
      opts: { force: true },
      allowInstallPolicyWarningPrompt: false,
    });
    if (!preflight.ok) {
      throw new Error(preflight.error);
    }
    expect(preflight.installMode).toBe("update");
    const updated = await installPluginFromGitSpec({ spec, mode: preflight.installMode });
    expect(updated).toMatchObject({ ok: true, targetDir: installed.targetDir, version: "2.0.0" });
    expect(await git(installed.targetDir, "rev-parse", "HEAD")).toBe(nextCommit);
  });

  it("installs a missing update target and preserves it when a tracked update changes plugin id", async () => {
    const installed = await installPluginFromGitSpec({
      spec,
      mode: "update",
      expectedPluginId: "demo",
    });
    if (!installed.ok) {
      throw new Error(installed.error);
    }
    await commitPlugin("renamed-demo", "2.0.0");
    const updated = await installPluginFromGitSpec({
      spec,
      mode: "update",
      expectedPluginId: "demo",
    });
    expect(updated).toMatchObject({
      ok: false,
      error: "plugin id mismatch: expected demo, got renamed-demo",
    });
    expect(await git(installed.targetDir, "rev-parse", "HEAD")).toBe(installed.git.commit);
  });
});
