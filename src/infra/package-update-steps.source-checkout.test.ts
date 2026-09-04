import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-global.js";

const SOURCE_VERSION = "2026.8.1";
const SOURCE_SHA = "a".repeat(40);

async function writeSourceCheckout(checkoutRoot: string): Promise<void> {
  await fs.mkdir(checkoutRoot, { recursive: true });
  for (const dir of [".git", "src", "extensions", "dist/control-ui/assets"]) {
    await fs.mkdir(path.join(checkoutRoot, dir), { recursive: true });
  }
  for (const [file, contents] of Object.entries({
    "package.json": JSON.stringify({ name: "openclaw", version: SOURCE_VERSION }),
    "pnpm-workspace.yaml": "packages: []\n",
    "dist/entry.js": "export {};\n",
    "dist/build-info.json": JSON.stringify({ commit: SOURCE_SHA }),
    "dist/.buildstamp": JSON.stringify({ head: SOURCE_SHA }),
    "dist/.runtime-postbuildstamp": JSON.stringify({ head: SOURCE_SHA }),
    "dist/control-ui/index.html": '<script src="./assets/startup.js"></script>',
    "dist/control-ui/assets/startup.js": "export {};\n",
  })) {
    await fs.writeFile(path.join(checkoutRoot, file), contents);
  }
  await fs.writeFile(path.join(checkoutRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
}

describe("runGlobalPackageUpdateSteps", () => {
  it("refuses a prepared checkout when the manager cannot identify its installed root", async () => {
    const postVerifyStep = vi.fn();
    const result = await runGlobalPackageUpdateSteps({
      installTarget: { manager: "pnpm", command: "pnpm", globalRoot: null, packageRoot: null },
      installSpec: "/prepared-checkout",
      packageName: "openclaw",
      expectedGitCheckout: { root: "/prepared-checkout", sha: SOURCE_SHA },
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      runStep: async ({ name, argv }) => ({
        name,
        command: argv.join(" "),
        cwd: "/",
        durationMs: 0,
        exitCode: 0,
      }),
      timeoutMs: 1000,
      postVerifyStep,
    });
    expect(result.failedStep).toMatchObject({
      name: "global install verify",
      stderrTail: "could not identify the installed package root",
    });
    expect(postVerifyStep).not.toHaveBeenCalled();
  });

  it("does not authorize the old global package after candidate Git Doctor", async () => {
    await withTestDir({ prefix: "openclaw-git-exposure-recovery-" }, async (base) => {
      const globalRoot = path.join(base, "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await writeSourceCheckout(path.join(base, "prepared-checkout"));
      const runStep = vi.fn();
      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          ...createNpmTarget(globalRoot),
          npmOwner: { version: null, lifecyclePolicy: null },
        },
        installSpec: path.join(base, "prepared-checkout"),
        expectedGitCheckout: { root: path.join(base, "prepared-checkout"), sha: SOURCE_SHA },
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "state-migration-started",
      });
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  describe.each(["npm", "pnpm", "bun"] as const)("%s source checkout activation", (manager) => {
    it.each([
      { name: "prepared checkout", error: null },
      { name: "wrong checkout", error: "expected checkout" },
      { name: "accidental source link", error: "source checkout" },
      { name: "missing build entry", remove: "dist/entry.js", error: "entry=false" },
      {
        name: "missing runtime stamp",
        remove: "dist/.runtime-postbuildstamp",
        error: "runtimeStamp=missing",
      },
      {
        name: "stale build identity",
        stale: "dist/build-info.json",
        error: "git runtime mismatch",
      },
      { name: "stale build stamp", stale: "dist/.buildstamp", error: "git runtime mismatch" },
      { name: "missing build identity", remove: "dist/build-info.json", error: "build=missing" },
      { name: "missing built SHA", error: "expected=missing" },
      { name: "missing UI index", remove: "dist/control-ui/index.html", error: "ui=missing-index" },
      {
        name: "incomplete UI",
        remove: "dist/control-ui/assets/startup.js",
        error: "ui=incomplete",
      },
      { name: "missing launcher", remove: "openclaw.mjs", error: "missing" },
    ])("verifies $name before finalization", async ({ name: caseName, error, remove, stale }) => {
      await withTestDir({ prefix: "openclaw-package-update-source-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot =
          manager === "npm"
            ? path.join(prefix, "lib", "node_modules")
            : manager === "pnpm"
              ? path.join(prefix, "global", "5", "node_modules")
              : path.join(prefix, ".bun", "install", "global", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const checkoutRoot = path.join(base, "checkout");
        const linkedRoot =
          caseName === "wrong checkout" ? path.join(base, "other-checkout") : checkoutRoot;
        await writePackageRoot(packageRoot, "1.0.0");
        await writeSourceCheckout(checkoutRoot);
        if (linkedRoot !== checkoutRoot) {
          await writeSourceCheckout(linkedRoot);
        }
        if (remove) {
          await fs.rm(path.join(checkoutRoot, remove));
        }
        if (stale) {
          await fs.writeFile(
            path.join(checkoutRoot, stale),
            JSON.stringify({ commit: "b".repeat(40), head: "b".repeat(40) }),
          );
        }
        const postVerifyStep = vi.fn(async () => ({
          name: "candidate doctor",
          command: "doctor",
          cwd: packageRoot,
          durationMs: 0,
          exitCode: 0,
        }));
        const result = await runGlobalPackageUpdateSteps({
          installTarget:
            manager === "npm"
              ? createNpmTarget(globalRoot)
              : { manager, command: manager, globalRoot, packageRoot },
          installSpec: checkoutRoot,
          expectedGitCheckout:
            caseName === "accidental source link"
              ? undefined
              : { root: checkoutRoot, sha: caseName === "missing built SHA" ? null : SOURCE_SHA },
          packageName: "openclaw",
          packageRoot,
          installCwd: checkoutRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            expect(name).toBe("global update");
            let targetRoot = packageRoot;
            if (manager === "npm") {
              const stagePrefix = argv[argv.indexOf("--prefix") + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              expect(path.dirname(stagePrefix)).toBe(globalRoot);
              const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
              targetRoot = path.join(stageLayout.globalRoot, "openclaw");
              await fs.mkdir(stageLayout.binDir, { recursive: true });
              await fs.symlink(
                "../lib/node_modules/openclaw/openclaw.mjs",
                path.join(stageLayout.binDir, "openclaw"),
              );
            } else {
              await fs.rm(packageRoot, { recursive: true });
            }
            await fs.mkdir(path.dirname(targetRoot), { recursive: true });
            await fs.symlink(
              process.platform === "win32"
                ? linkedRoot
                : path.relative(path.dirname(targetRoot), linkedRoot),
              targetRoot,
              process.platform === "win32" ? "junction" : undefined,
            );
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
          timeoutMs: 1000,
          postVerifyStep,
        });
        if (error) {
          expect(result.failedStep).toMatchObject({
            name: "global install verify",
            stderrTail: expect.stringContaining(error),
          });
          expect(postVerifyStep).not.toHaveBeenCalled();
          if (manager === "npm") {
            expect(result.afterVersion).toBe("1.0.0");
            expect(result.steps.some((step) => step.name === "global install swap")).toBe(false);
            await expect(
              fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"1.0.0"');
          }
        } else {
          expect(result.failedStep).toBeNull();
          expect(result.verifiedPackageRoot).toBe(packageRoot);
          expect(result.afterVersion).toBe(SOURCE_VERSION);
          expect(postVerifyStep).toHaveBeenCalledWith(packageRoot);
          await expect(fs.realpath(packageRoot)).resolves.toBe(checkoutRoot);
          if (manager === "npm") {
            expect(result.steps.map((step) => step.name)).toEqual([
              "global update",
              "global install swap",
              "candidate doctor",
            ]);
            await expect(fs.readlink(path.join(prefix, "bin", "openclaw"))).resolves.toBe(
              "../lib/node_modules/openclaw/openclaw.mjs",
            );
            expect(
              (await fs.readdir(globalRoot)).filter((entry) =>
                entry.startsWith(".openclaw-update-stage-"),
              ),
            ).toEqual([]);
          }
        }
      });
    });
  });
});
