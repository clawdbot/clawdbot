import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneBundledPluginSourceNodeModules } from "../../scripts/postinstall-bundled-plugins.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cli = path.resolve(import.meta.dirname, "../../scripts/lib/plugin-npm-runtime-build.mjs");

function writeFile(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(format = "esm", declaration = "peerDependencies") {
  const root = tempDirs.make("openclaw-native-import-");
  fs.mkdirSync(path.join(root, "src"));
  writeFile(root, "pnpm-workspace.yaml", "packages:\n  - extensions/*\n");
  // Setup runs source tooling with workspace aliases; native children below do not load tsx.
  writeFile(
    root,
    "tsconfig.json",
    JSON.stringify({ extends: path.resolve(import.meta.dirname, "../../tsconfig.json") }),
  );
  writeFile(
    root,
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version: "1.0.0",
      type: "module",
      exports: { "./plugin-sdk/fixture": "./dist/plugin-sdk/fixture.js" },
    }),
  );
  writeFile(root, "dist/plugin-sdk/fixture.js", 'export const host = "host";\n');
  writeFile(
    root,
    "node_modules/fixture-dep/package.json",
    JSON.stringify({ name: "fixture-dep", main: "index.cjs" }),
  );
  writeFile(root, "node_modules/fixture-dep/index.cjs", 'exports.thirdParty = "third-party";\n');
  const packageDir = path.join(root, "extensions/demo");
  writeFile(
    packageDir,
    "package.json",
    JSON.stringify({
      name: "@openclaw/demo",
      version: "1.0.0",
      type: "module",
      optionalDependencies: { "fixture-dep": "1.0.0" },
      [declaration]: { openclaw: "*" },
      openclaw: {
        extensions: ["./index.ts"],
        build: { runtimeFormat: format },
        release: { publishToNpm: true },
      },
    }),
  );
  writeFile(
    packageDir,
    "index.ts",
    [
      'import { host } from "openclaw/plugin-sdk/fixture";',
      'import { thirdParty } from "fixture-dep";',
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("executed", "yes");',
      "export const answer = `${host} ${thirdParty}`;",
    ].join("\n"),
  );
  const entry = `./extensions/demo/dist/index.${format === "cjs" ? "cjs" : "js"}`;
  writeFile(root, entry, 'throw new Error("Preparation must not execute plugin code");\n');
  return { root, packageDir, entry };
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

function nativeImport(root: string, entry: string, format: string) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      format === "cjs"
        ? `import { createRequire } from "node:module"; console.log(createRequire(import.meta.url)(${JSON.stringify(entry)}).answer);`
        : `console.log((await import(${JSON.stringify(entry)})).answer);`,
    ],
    { cwd: root, encoding: "utf8", env },
  );
}

function snapshot(root: string, directories: string[]) {
  return Object.fromEntries(
    directories
      .flatMap((directory) => {
        const target = path.join(root, directory);
        return [
          directory,
          ...fs
            .readdirSync(target, { recursive: true })
            .map((name) => path.join(directory, String(name))),
        ];
      })
      .map((relative) => {
        const target = path.join(root, relative);
        const stat = fs.statSync(target, { bigint: true });
        return [
          relative,
          {
            mtime: stat.mtimeNs,
            hash: stat.isFile()
              ? createHash("sha256").update(fs.readFileSync(target)).digest("hex")
              : null,
          },
        ];
      }),
  );
}

describe("explicit source native-import preparation", () => {
  it.each([
    ["esm", "peerDependencies"],
    ["cjs", "peerDependencies"],
    ["esm", "dependencies"],
    ["cjs", "dependencies"],
  ])(
    "prepares pruned %s output with an actual %s host without rebuilding",
    (format, declaration) => {
      const { root, packageDir, entry } = fixture(format, declaration);
      fs.mkdirSync(path.join(packageDir, "node_modules"));
      fs.symlinkSync(root, path.join(packageDir, "node_modules/openclaw"), "junction");
      pruneBundledPluginSourceNodeModules({ extensionsDir: path.join(root, "extensions") });

      const compiled = runCli(root, ["extensions/demo"]);
      expect(compiled.status, compiled.stderr).toBe(0);
      expect(fs.existsSync(path.join(packageDir, "node_modules"))).toBe(false);
      const missing = nativeImport(root, entry, format);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/Cannot find (?:package|module) 'openclaw/u);

      writeFile(packageDir, "node_modules/keep/marker", "unrelated local contents");
      const directories = [
        "dist",
        "extensions/demo/dist",
        "node_modules",
        "extensions/demo/node_modules/keep",
      ];
      const before = snapshot(root, directories);
      const prepared = runCli(root, ["--prepare-native-import", "extensions/demo"]);
      expect(prepared.status, prepared.stderr).toBe(0);
      expect(fs.existsSync(path.join(root, "executed"))).toBe(false);
      const link = path.join(packageDir, "node_modules/openclaw");
      expect(fs.realpathSync(link)).toBe(root);
      const linkBefore = fs.lstatSync(link, { bigint: true });
      const repeated = runCli(root, ["extensions/demo", "--prepare-native-import"]);
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(fs.lstatSync(link, { bigint: true }).mtimeNs).toBe(linkBefore.mtimeNs);
      expect(snapshot(root, directories)).toEqual(before);

      const loaded = nativeImport(root, entry, format);
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout.trim()).toBe("host third-party");
      expect(fs.readFileSync(path.join(root, "executed"), "utf8")).toBe("yes");
      expect(snapshot(root, directories)).toEqual(before);
    },
  );

  it.each(["devDependencies", "optionalDependencies"])(
    "does not infer a host declaration from %s or publication metadata",
    (declaration) => {
      const { root, packageDir } = fixture("esm", declaration);
      const result = runCli(root, ["--prepare-native-import", "extensions/demo"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/does not declare openclaw/u);
      expect(fs.existsSync(path.join(packageDir, "node_modules"))).toBe(false);
    },
  );

  it.each([
    "outside package",
    "nested package",
    "symlinked package",
    "symlinked extensions",
    "symlinked manifest",
    "invalid manifest",
    "wrong host",
    "not source",
    "missing host output",
    "missing plugin output",
    "symlinked node_modules",
    "unrelated host directory",
  ])("rejects %s without changing artifacts or unrelated contents", (scenario) => {
    const { root, packageDir } = fixture();
    const outside = tempDirs.make("openclaw-native-import-outside-");
    writeFile(outside, "marker", "keep");
    let selected = "extensions/demo";
    let expected = /real immediate extensions/u;
    switch (scenario) {
      case "outside package":
        selected = outside;
        break;
      case "nested package":
        selected = "extensions/demo/nested";
        break;
      case "symlinked package":
        fs.renameSync(packageDir, path.join(outside, "demo"));
        fs.symlinkSync(path.join(outside, "demo"), packageDir, "junction");
        break;
      case "symlinked extensions":
        fs.renameSync(path.join(root, "extensions"), path.join(outside, "extensions"));
        fs.symlinkSync(path.join(outside, "extensions"), path.join(root, "extensions"), "junction");
        break;
      case "symlinked manifest":
        fs.renameSync(path.join(packageDir, "package.json"), path.join(outside, "package.json"));
        fs.symlinkSync(path.join(outside, "package.json"), path.join(packageDir, "package.json"));
        expected = /safely read.*package.json/u;
        break;
      case "invalid manifest":
        writeFile(packageDir, "package.json", "[]");
        expected = /safely read.*package.json/u;
        break;
      case "wrong host":
        writeFile(root, "package.json", JSON.stringify({ name: "unrelated" }));
        expected = /source checkout root/u;
        break;
      case "not source":
        fs.rmdirSync(path.join(root, "src"));
        expected = /source checkout root/u;
        break;
      case "missing host output":
        fs.rmSync(path.join(root, "dist"), { recursive: true });
        expected = /Host SDK output is missing/u;
        break;
      case "missing plugin output":
        fs.rmSync(path.join(packageDir, "dist"), { recursive: true });
        expected = /run node scripts\/lib\/plugin-npm-runtime-build.mjs/u;
        break;
      case "symlinked node_modules":
        fs.symlinkSync(outside, path.join(packageDir, "node_modules"), "junction");
        expected = /not a real directory/u;
        break;
      case "unrelated host directory":
        writeFile(
          packageDir,
          "node_modules/openclaw/package.json",
          JSON.stringify({ name: "unrelated" }),
        );
        writeFile(packageDir, "node_modules/openclaw/marker", "keep");
        expected = /already exists and is not a symlink/u;
        break;
    }
    const before = snapshot(root, ["."]);
    const outsideBefore = snapshot(outside, ["."]);
    const result = runCli(root, ["--prepare-native-import", selected]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(expected);
    expect(snapshot(root, ["."])).toEqual(before);
    expect(snapshot(outside, ["."])).toEqual(outsideBefore);
  });
});
