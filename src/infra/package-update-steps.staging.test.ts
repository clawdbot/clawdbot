import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-global.js";

function stagedPrefixFromArgs(argv: string[]): string {
  const prefixIndex = argv.indexOf("--prefix");
  const prefix = argv[prefixIndex + 1];
  if (prefixIndex < 0 || !prefix) {
    throw new Error("expected a production-created staged npm prefix");
  }
  return prefix;
}

// Package-owner boundary interleaving with injected package-manager steps;
// this does not reproduce overlapping public CLI invocations or a triage incident.
describe("runGlobalPackageUpdateSteps staging ownership", () => {
  it.each([
    { stage: "ordinary npm", omitOptional: false },
    { stage: "recreated omit-optional npm", omitOptional: true },
  ])(
    "preserves an active $stage candidate through another owner's cleanup",
    async ({ omitOptional }) => {
      await withTestDir({ prefix: "openclaw-package-stage-interleaving-" }, async (base) => {
        const { globalRoot } = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(base, "prefix"));
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageFiles = [
          "package.json",
          "dist/index.js",
          PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
        ];
        const readPackageBytes = (root: string) =>
          packageFiles.map((relativePath) => fs.readFile(path.join(root, relativePath), "utf8"));
        await writePackageRoot(packageRoot, "1.0.0");
        const originalBytes = await Promise.all(readPackageBytes(packageRoot));
        const params = {
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          timeoutMs: 1000,
        };
        const aPrefixes: string[] = [];
        let candidateBytes: string[] = [];
        const protectedBackup = path.join(globalRoot, ".openclaw.package-backup-recovery");

        const result = await runGlobalPackageUpdateSteps({
          ...params,
          runStep: async ({ name, argv, cwd }) => {
            const stagePrefix = stagedPrefixFromArgs(argv);
            expect((await fs.stat(stagePrefix)).isDirectory()).toBe(true);
            aPrefixes.push(stagePrefix);
            const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
            const candidateRoot = path.join(stageLayout.globalRoot, "openclaw");
            await writePackageRoot(candidateRoot, "2.0.0");
            const step = { name, command: argv.join(" "), cwd: cwd ?? base, durationMs: 0 };
            if (omitOptional && aPrefixes.length === 1) {
              return { ...step, exitCode: 1, stderrTail: "injected optional dependency failure" };
            }
            expect(argv.includes("--omit=optional")).toBe(omitOptional);
            if (omitOptional) {
              const firstPrefix = aPrefixes[0]!;
              expect(stagePrefix).not.toBe(firstPrefix);
              await expect(fs.access(firstPrefix)).rejects.toMatchObject({ code: "ENOENT" });
            }
            candidateBytes = await Promise.all(readPackageBytes(candidateRoot));

            // Seed after A's initial cleanup so only the nested B can remove these.
            const obsoleteDirs = [
              ".openclaw-a1b2c3d4",
              ".openclaw-package-backup-retired",
              ".openclaw-shim-backup-retired",
            ].map((entry) => path.join(globalRoot, entry));
            for (const directory of [...obsoleteDirs, protectedBackup]) {
              await fs.mkdir(directory);
              await fs.writeFile(path.join(directory, "evidence"), "existing backup bytes\n");
            }

            let bPrefix: string | undefined;
            const stoppedB = await runGlobalPackageUpdateSteps({
              ...params,
              runStep: async ({ argv: bArgv }) => {
                bPrefix = stagedPrefixFromArgs(bArgv);
                expect(bPrefix).not.toBe(stagePrefix);
                expect((await fs.stat(bPrefix)).isDirectory()).toBe(true);
                throw new Error("injected B stop before live mutation");
              },
            });
            expect(stoppedB).toMatchObject({
              failedStep: { exitCode: 1, stderrTail: "injected B stop before live mutation" },
              afterVersion: null,
              recovery: { serviceRestartSafe: true, version: "1.0.0" },
            });
            if (!bPrefix) {
              throw new Error("B did not reach its package-manager step");
            }
            for (const removed of [bPrefix, ...obsoleteDirs]) {
              await expect(fs.access(removed)).rejects.toMatchObject({ code: "ENOENT" });
            }
            await expect(fs.readFile(path.join(protectedBackup, "evidence"), "utf8")).resolves.toBe(
              "existing backup bytes\n",
            );
            expect(await Promise.all(readPackageBytes(packageRoot))).toEqual(originalBytes);
            const survivingCandidate = await Promise.allSettled(readPackageBytes(candidateRoot));
            // Keep A running after this diagnostic so real verification and cleanup also settle.
            expect
              .soft(survivingCandidate, "B cleanup must preserve A's existing candidate bytes")
              .toEqual(candidateBytes.map((value) => ({ status: "fulfilled", value })));
            return { ...step, exitCode: 0 };
          },
        });

        expect(aPrefixes).toHaveLength(omitOptional ? 2 : 1);
        for (const prefix of aPrefixes) {
          await expect(fs.access(prefix)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect((await fs.readdir(globalRoot)).toSorted()).toEqual(
          [path.basename(protectedBackup), "openclaw"].toSorted(),
        );
        expect(result).toMatchObject({
          failedStep: null,
          afterVersion: "2.0.0",
          verifiedPackageRoot: packageRoot,
          recovery: { serviceRestartSafe: true, version: "2.0.0" },
        });
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "global install swap", exitCode: 0 }),
        );
        expect(await Promise.all(readPackageBytes(packageRoot))).toEqual(candidateBytes);
      });
    },
  );
});
