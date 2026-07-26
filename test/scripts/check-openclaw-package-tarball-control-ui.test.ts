import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mjs";

const CONTROL_UI_INDEX = "dist/control-ui/index.html";
const CONTROL_UI_ASSETS = [
  "dist/control-ui/assets/app.js",
  "dist/control-ui/assets/app.js.br",
  "dist/control-ui/assets/app.js.gz",
] as const;
const CONTROL_UI_FILES = [CONTROL_UI_INDEX, ...CONTROL_UI_ASSETS];
const CHECK_SCRIPT = resolve("scripts/check-openclaw-package-tarball.mjs");
const TYPESCRIPT_PACKAGE_ROOT = fileURLToPath(
  new URL("../../node_modules/typescript", import.meta.url),
);

function writeFixtureFile(packageRoot: string, relativePath: string, content: string): void {
  const filePath = join(packageRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function withPackedPackage(
  inventory: readonly string[],
  run: (fixture: { root: string; tarball: string }) => void,
  options: { postinstall?: boolean } = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-control-ui-package-inventory-"));
  const packageRoot = join(root, "package");
  try {
    mkdirSync(packageRoot, { recursive: true });
    const version = "2026.7.2";
    const typescriptRoot = resolve("node_modules/typescript");
    const typescriptVersion = (
      JSON.parse(readFileSync(join(typescriptRoot, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    writeFixtureFile(
      packageRoot,
      "package.json",
      JSON.stringify({
        name: "openclaw",
        version,
        type: "module",
        ...(options.postinstall === false
          ? {}
          : {
              scripts: { postinstall: "node scripts/postinstall-bundled-plugins.mjs" },
              dependencies: { typescript: typescriptVersion },
              bundledDependencies: ["typescript"],
            }),
      }),
    );
    writeFixtureFile(packageRoot, "dist/postinstall-inventory.json", JSON.stringify(inventory));
    writeFixtureFile(packageRoot, "dist/index.js", "export {};\n");
    writeFixtureFile(
      packageRoot,
      CONTROL_UI_INDEX,
      '<!doctype html><script type="module" src="./assets/app.js"></script>\n',
    );
    for (const assetPath of CONTROL_UI_ASSETS) {
      writeFixtureFile(packageRoot, assetPath, "shipped Control UI asset\n");
    }
    writeFixtureFile(
      packageRoot,
      "dist/openclaw-install-guard",
      "OpenClaw package preinstall has not completed.\n",
    );
    for (const relativePath of WORKSPACE_TEMPLATE_PACK_PATHS) {
      writeFixtureFile(packageRoot, relativePath, `# ${relativePath}\n`);
    }
    for (const relativePath of [
      "scripts/postinstall-bundled-plugins.mjs",
      "scripts/lib/guard-inventory-utils.mjs",
      "scripts/lib/package-dist-imports.mjs",
    ]) {
      const destination = join(packageRoot, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(relativePath), destination);
    }
    if (options.postinstall !== false) {
      // Offline npm must exercise the same bundled TypeScript AST dependency
      // that the real postinstall uses to preserve its complete import graph.
      cpSync(typescriptRoot, join(packageRoot, "node_modules/typescript"), {
        recursive: true,
      });
    }

    const packed = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
    );
    expect(packed.status, packed.stderr || packed.error?.message).toBe(0);
    // npm <=11 `pack --json` emits an array; npm 12 emits an object keyed by package name.
    const parsed = JSON.parse(packed.stdout) as
      | { filename: string }[]
      | Record<string, { filename: string }>;
    const packResult = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const filename = packResult?.filename ?? "";
    const tarball = join(root, filename);
    expect(existsSync(tarball)).toBe(true);
    run({ root, tarball });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function checkPackedPackage(tarball: string) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, tarball], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function installPackedPackage(root: string, tarball: string) {
  const home = join(root, "home");
  const state = join(root, "state");
  const temporary = join(root, "tmp");
  for (const directory of [home, state, temporary]) {
    mkdirSync(directory, { recursive: true });
  }
  const installRoot = join(root, "installed");
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(
    join(installRoot, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  const result = spawnSync(
    "npm",
    [
      "install",
      "--foreground-scripts",
      "--dangerously-allow-all-scripts",
      "--prefix",
      installRoot,
      "--no-audit",
      "--no-fund",
      "--offline",
      TYPESCRIPT_PACKAGE_ROOT,
      tarball,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      },
    },
  );
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return join(installRoot, "node_modules", "openclaw");
}

describe("packaged Control UI postinstall inventory", () => {
  it.each(CONTROL_UI_FILES)(
    "rejects a real npm package when postinstall would delete %s",
    (omittedFile) => {
      const inventory = ["dist/index.js", ...CONTROL_UI_FILES].filter(
        (relativePath) => relativePath !== omittedFile,
      );
      withPackedPackage(inventory, ({ tarball }) => {
        const result = checkPackedPackage(tarball);

        expect(result.status, result.stdout).not.toBe(0);
        expect(result.stderr).toContain(
          `postinstall inventory omits Control UI file ${omittedFile}`,
        );
      });
    },
  );

  it("proves actual npm postinstall deletes an omitted dashboard from a falsely accepted package", () => {
    withPackedPackage(["dist/index.js"], ({ root, tarball }) => {
      const validation = checkPackedPackage(tarball);
      const installedPackageRoot = installPackedPackage(root, tarball);
      expect(existsSync(join(installedPackageRoot, "dist/index.js"))).toBe(true);
      for (const relativePath of CONTROL_UI_FILES) {
        expect(existsSync(join(installedPackageRoot, relativePath))).toBe(false);
      }

      expect(validation.status, validation.stdout).not.toBe(0);
      expect(validation.stderr).toContain(
        "postinstall inventory omits Control UI file dist/control-ui/index.html",
      );
    });
  });

  it("accepts a packaged dashboard whose complete UI survives postinstall", () => {
    withPackedPackage(["dist/index.js", ...CONTROL_UI_FILES], ({ root, tarball }) => {
      const result = checkPackedPackage(tarball);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");

      const installedPackageRoot = installPackedPackage(root, tarball);
      for (const relativePath of CONTROL_UI_FILES) {
        expect(existsSync(join(installedPackageRoot, relativePath))).toBe(true);
      }
    });
  });

  it("does not impose postinstall inventory rules on lifecycle-free archived fixtures", () => {
    withPackedPackage(
      ["dist/index.js"],
      ({ tarball }) => {
        const result = checkPackedPackage(tarball);

        expect(result.status, result.stderr).toBe(0);
      },
      { postinstall: false },
    );
  });
});
