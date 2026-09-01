import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "../../scripts/lib/package-dist-inventory-contract.mts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { withTempDirSync } from "../../src/test-helpers/temp-dir.js";

const repoRoot = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const writerPath = path.join(repoRoot, "scripts/write-package-dist-inventory.ts");
const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function withPackageFixture(run: (packageRoot: string) => void) {
  withTempDirSync({ prefix: "openclaw-path-alias-inventory-" }, (packageRoot) => {
    fs.mkdirSync(path.join(packageRoot, "dist"));
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(packageRoot, "dist/entry.js"), "export {};\n");
    run(packageRoot);
  });
}

function runNode(packageRoot: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--import", loaderUrl, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      // The tiny cwd fixture still uses the real source closure's workspace aliases.
      TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
      TSX_DISABLE_CACHE: "1",
      pm_exec_path: writerPath,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("write-package-dist-inventory direct entry", () => {
  it.each(["canonical", "directory alias"])("writes both artifacts via %s", (entry) => {
    withPackageFixture((packageRoot) => {
      let scriptPath = writerPath;
      if (entry === "directory alias") {
        const sourceAlias = path.join(packageRoot, "source-alias");
        fs.symlinkSync(repoRoot, sourceAlias, process.platform === "win32" ? "junction" : "dir");
        scriptPath = path.join(sourceAlias, "scripts/write-package-dist-inventory.ts");
      }

      runNode(packageRoot, [scriptPath]);

      expect(
        JSON.parse(
          fs.readFileSync(path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH), "utf8"),
        ),
      ).toEqual(["dist/entry.js"]);
      expect(
        fs.readFileSync(path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH), "utf8"),
      ).toBe("pending\n");
      expect(fs.readdirSync(path.join(packageRoot, "dist")).sort()).toEqual(
        ["entry.js", path.basename(PACKAGE_DIST_INVENTORY_RELATIVE_PATH)].sort(),
      );
    });
  });

  describe.each([false, true])("import with existing artifacts=%s", (seeded) => {
    it.each(["no argv", "same basename"])("stays inert with %s and PM2 hints", (entry) => {
      withPackageFixture((packageRoot) => {
        const expected: Record<string, string> = { "entry.js": "export {};\n" };
        if (seeded) {
          expected[path.basename(PACKAGE_DIST_INVENTORY_RELATIVE_PATH)] = '["dist/previous.js"]\n';
          for (const [name, content] of Object.entries(expected)) {
            fs.writeFileSync(path.join(packageRoot, "dist", name), content);
          }
          fs.writeFileSync(
            path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
            "existing marker\n",
          );
        }
        const importSource = `await import(${JSON.stringify(pathToFileURL(writerPath).href)});\n`;
        const importerPath = path.join(packageRoot, path.basename(writerPath));
        fs.writeFileSync(importerPath, importSource);
        runNode(
          packageRoot,
          entry === "no argv" ? ["--input-type=module", "--eval", importSource] : [importerPath],
        );

        const actual = Object.fromEntries(
          fs
            .readdirSync(path.join(packageRoot, "dist"))
            .map((name) => [name, fs.readFileSync(path.join(packageRoot, "dist", name), "utf8")]),
        );
        expect(actual).toEqual(expected);
        const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
        if (seeded) {
          expect(fs.readFileSync(markerPath, "utf8")).toBe("existing marker\n");
        } else {
          expect(fs.existsSync(markerPath)).toBe(false);
        }
      });
    });
  });
});
