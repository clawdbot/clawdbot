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

  it.each(["backup", "activation"] as const)(
    "handles a %s move rejected after destination commit",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-package-move-recovery-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        let source = failure === "backup" ? packageRoot : "";
        let copied = false;
        let cleanupRejected = false;
        const rename = fs.rename.bind(fs);
        const unlink = fs.unlink.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === source && !copied) {
            copied = true;
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return await rename(...args);
        });
        const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
          await unlink(target);
          if (String(target) === path.join(source, "dist", "index.js") && !cleanupRejected) {
            cleanupRejected = true;
            throw Object.assign(new Error("source cleanup failed after commit"), {
              code: "EACCES",
            });
          }
        });
        let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
        try {
          result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            timeoutMs: 1000,
            runStep: async ({ name, argv }) => {
              const prefix = argv[argv.indexOf("--prefix") + 1];
              if (!prefix) {
                throw new Error("missing stage prefix");
              }
              const staged = path.join(prefix, "lib", "node_modules", "openclaw");
              await writePackageRoot(staged, "2.0.0");
              if (failure === "activation") {
                source = staged;
              }
              return { name, command: argv.join(" "), cwd: prefix, durationMs: 0, exitCode: 0 };
            },
          });
        } finally {
          renameSpy.mockRestore();
          unlinkSpy.mockRestore();
        }
        expect(cleanupRejected).toBe(true);
        expect(result.failedStep?.stderrTail).toContain("source cleanup failed after commit");
        if (failure === "backup") {
          expect(result.recovery?.serviceRestartSafe).toBe(false);
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const backups = (await fs.readdir(globalRoot)).filter((name) =>
            name.startsWith(`.openclaw.package-backup-${process.pid}-`),
          );
          expect(backups).toHaveLength(1);
          await expect(
            fs.readFile(path.join(globalRoot, backups[0] ?? "", "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        } else {
          expect(result.recovery?.serviceRestartSafe).not.toBe(false);
          expect(result.afterVersion).toBe("1.0.0");
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        }
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
