import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";

describe("package update recovery safety", () => {
  it.each(
    (["pnpm", "bun", "npm"] as const).flatMap((manager) =>
      ["install exit", "install throw", "doctor throw"].map((failure) => ({ manager, failure })),
    ),
  )(
    "keeps $manager recovery stopped after $failure mutates the live tree",
    async ({ manager, failure }) => {
      await withTestDir({ prefix: "openclaw-package-recovery-" }, async (base) => {
        const globalRoot = path.join(base, "global");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const params = {
          installTarget:
            manager === "npm"
              ? createNpmTarget(globalRoot)
              : { manager, command: manager, globalRoot, packageRoot },
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }: { name: string; argv: string[] }) => {
            await writePackageRoot(packageRoot, "2.0.0");
            if (failure === "install throw") {
              throw new Error("install interrupted after replacement");
            }
            return {
              name,
              command: argv.join(" "),
              cwd: globalRoot,
              durationMs: 0,
              exitCode: failure === "install exit" ? 1 : 0,
            };
          },
          postVerifyStep: async () => {
            throw new Error("doctor interrupted after replacement");
          },
          timeoutMs: 1000,
        };
        const result = await runGlobalPackageUpdateSteps(params);

        expect(result.failedStep).not.toBeNull();
        expect(result.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        });
        if (failure === "doctor throw") {
          expect(result.afterVersion).toBe("2.0.0");
        }
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          '"version":"2.0.0"',
        );
      });
    },
  );

  it("reports a throwing Doctor after a staged npm swap as unsafe recovery", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-swap-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv }) => {
          const prefix = argv[argv.indexOf("--prefix") + 1];
          if (!prefix) {
            throw new Error("missing stage prefix");
          }
          await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "2.0.0");
          return { name, command: argv.join(" "), cwd: prefix, durationMs: 0, exitCode: 0 };
        },
        postVerifyStep: async () => {
          throw new Error("doctor interrupted after swap");
        },
        timeoutMs: 1000,
      });
      expect(result.failedStep?.stderrTail).toContain("doctor interrupted after swap");
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
        '"version":"2.0.0"',
      );
    });
  });
});
