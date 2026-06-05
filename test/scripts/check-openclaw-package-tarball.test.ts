// Check Openclaw Package Tarball tests cover check openclaw package tarball script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";

const CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mjs";
const FLAT_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/provider-entry.d.ts";
const DEEP_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts";

function withTarball(
  inventory: string[],
  files: Record<string, string>,
  testBody: (tarball: string) => void,
  version = "0.0.0",
  options: { includeControlUi?: boolean; includeShrinkwrap?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-test-"));
  try {
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw", version }));
    if (options.includeShrinkwrap !== false) {
      writeFileSync(
        join(packageRoot, "npm-shrinkwrap.json"),
        JSON.stringify({
          name: "openclaw",
          version,
          lockfileVersion: 3,
          packages: {
            "": {
              name: "openclaw",
              version,
            },
          },
        }),
      );
    }
    writeFileSync(
      join(packageRoot, "dist", "postinstall-inventory.json"),
      JSON.stringify(inventory),
    );
    const tarFiles =
      options.includeControlUi === false
        ? files
        : {
            "dist/control-ui/index.html": "<!doctype html><openclaw-app></openclaw-app>",
            "dist/control-ui/assets/app.js": "console.log('ok');\n",
            ...files,
          };
    for (const [relativePath, body] of Object.entries(tarFiles)) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }

    const tarball = join(root, "openclaw.tgz");
    const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], {
      encoding: "utf8",
    });
    expect(pack.status, pack.stderr).toBe(0);
    testBody(tarball);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-openclaw-package-tarball", () => {
  it.runIf(process.platform !== "win32")(
    "removes the extract dir when tar extraction fails",
    () => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-extract-fail-"));
      try {
        const fakeBin = join(root, "bin");
        mkdirSync(fakeBin);
        const extractDirFile = join(root, "extract-dir.txt");
        const fakeTar = join(fakeBin, "tar");
        writeFileSync(
          fakeTar,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const args = process.argv.slice(2);",
            "if (args[0] === '-tf') { console.log('package/package.json'); process.exit(0); }",
            "const outputDir = args[args.indexOf('-C') + 1];",
            "fs.writeFileSync(process.env.OPENCLAW_TEST_EXTRACT_DIR_FILE, outputDir);",
            "console.error('extract denied');",
            "process.exit(7);",
          ].join("\n"),
        );
        chmodSync(fakeTar, 0o755);
        const tarball = join(root, "openclaw.tgz");
        writeFileSync(tarball, "not used by fake tar");

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_TEST_EXTRACT_DIR_FILE: extractDirFile,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("extract denied");
        expect(existsSync(readFileSync(extractDirFile, "utf8"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("allows legacy private QA inventory entries omitted from shipped tarballs through 2026.4.25", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy inventory references omitted private QA");
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.25-beta.10",
    );
  });

  it("rejects legacy private QA inventory omissions for newer packages", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory references missing tar entry dist/extensions/qa-channel/runtime-api.js",
        );
        expect(result.stderr).not.toContain("legacy inventory references omitted private QA");
      },
      "2026.4.26",
    );
  });

  it("still rejects non-legacy missing inventory entries", () => {
    withTarball(
      ["dist/index.js", "dist/cli.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory references missing tar entry dist/cli.js");
      },
    );
  });

  it("rejects stale deep plugin SDK declaration inventory entries", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION, DEEP_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `inventory references missing tar entry ${DEEP_PLUGIN_SDK_DECLARATION}`,
        );
      },
    );
  });

  it("accepts flat plugin SDK declaration inventory without the old deep tree", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
    );
  });

  it("rejects dist files that import missing relative chunks", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      { "dist/cli/run-main.js": 'await import("../memory-state-old.js");\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "dist/cli/run-main.js imports missing dist/memory-state-old.js",
        );
      },
      "2026.4.27",
    );
  });

  it("accepts dist files whose relative chunks are present", () => {
    withTarball(
      ["dist/cli/run-main.js", "dist/memory-state-current.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("rejects imported dist chunks omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory omits imported dist file dist/memory-state-current.js",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects missing Control UI assets", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry dist/control-ui/index.html");
        expect(result.stderr).toContain(
          "missing required tar entries under dist/control-ui/assets/",
        );
      },
      "2026.4.27",
      { includeControlUi: false },
    );
  });

  it("allows legacy package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy package omits npm-shrinkwrap.json");
      },
      "2026.5.20",
      { includeShrinkwrap: false },
    );
  });

  it("rejects new package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry npm-shrinkwrap.json");
      },
      "2026.5.21",
      { includeShrinkwrap: false },
    );
  });

  it("rejects package-lock.json in package tarballs", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n", "package-lock.json": "{}\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package tarball must ship npm-shrinkwrap.json, not package-lock.json",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects local build metadata entries in package tarballs", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.runtime-postbuildstamp",
        );
      },
      "2026.4.27",
    );
  });

  it("allows local build metadata in already published legacy packages through 2026.4.26", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.runtime-postbuildstamp",
        );
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.26",
    );
  });
});
