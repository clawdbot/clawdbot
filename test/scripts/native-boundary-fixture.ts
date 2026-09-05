import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Native receipts and default libraries must belong to the fixture's own install. */
export function materializeNativeCompiler(rootDir: string) {
  const root = fs.realpathSync.native(rootDir);
  const platformPackage = `@typescript/native-preview-${process.platform}-${process.arch}`;
  // The platform binary belongs to native-preview's optional dependencies, not the root package.
  const nativeRequire = createRequire(require.resolve("@typescript/native-preview/package.json"));
  const modules = path.join(root, "node_modules");
  fs.mkdirSync(modules, { recursive: true });
  if (fs.realpathSync.native(modules) !== modules) {
    throw new Error("Native compiler fixtures need their own node_modules directory");
  }
  // Shared declaration fixtures start with tool links. Detach those fixture-owned
  // links before copying so no write can follow them back into the real install.
  for (const name of [
    ".bin",
    "@typescript",
    "typescript",
    "@typescript/native-preview",
    platformPackage,
  ]) {
    const target = path.join(root, "node_modules", name);
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.unlinkSync(target);
    }
  }
  for (const name of ["typescript", "@typescript/native-preview", platformPackage]) {
    const owner = name === platformPackage ? nativeRequire : require;
    const source = path.dirname(owner.resolve(`${name}/package.json`));
    const destination = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  }
  const bin = path.join(root, "node_modules/.bin/tsgo");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync("../@typescript/native-preview/bin/tsgo", bin, "file");
  if (process.platform === "win32") {
    fs.writeFileSync(
      `${bin}.cmd`,
      '@node "%~dp0..\\@typescript\\native-preview\\bin\\tsgo" %*\r\n',
    );
  }
  const getExePath: { default: () => string } = require(
    path.join(root, "node_modules/@typescript/native-preview/lib/getExePath.js"),
  );
  return getExePath.default();
}

export function resolveNativeFixtureShortPath(directory: string) {
  const short = spawnSync(
    "cmd.exe",
    ["/d", "/c", 'for %I in ("%DECLARATION_ALIAS_ROOT%") do @echo %~sI'],
    {
      encoding: "utf8",
      // cmd.exe owns these quotes; libuv must not backslash-escape them.
      windowsVerbatimArguments: true,
      env: { ...process.env, DECLARATION_ALIAS_ROOT: directory },
    },
  );
  if (short.error) {
    throw short.error;
  }
  if (short.status !== 0) {
    throw new Error(`Windows short-path lookup failed: ${short.stderr}`);
  }
  const target = short.stdout.trim();
  const canonical = fs.realpathSync.native(directory);
  if (fs.realpathSync.native(target) !== canonical) {
    throw new Error(`Windows short path does not resolve to its fixture directory: ${target}`);
  }
  return fs.realpathSync(target).toLowerCase() === canonical.toLowerCase() ? undefined : target;
}

export function writeNativeFixtureFile(root: string, file: string, text: string) {
  const target = path.resolve(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

/** Conflicting ancestor and importer-local @types exercise native triple-reference priority. */
export function installNativeAncestorTypes(ancestor: string, root: string) {
  const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
  const core = (origin: string) =>
    `export interface Marker { origin: "${origin}" }\ndeclare global { const declarationOrigin: "${origin}"; }\n`;
  const install = (directory: string, name: string, version: string, text: string) => {
    write(`${directory}/package.json`, JSON.stringify({ name, version, types: "index.d.ts" }));
    return write(`${directory}/index.d.ts`, text);
  };
  install(
    path.join(ancestor, "node_modules/@types/synthetic-core"),
    "@types/synthetic-core",
    "1.0.0",
    core("ancestor"),
  );
  const wrapper = install(
    "node_modules/.pnpm/wrapper/node_modules/@types/synthetic-wrapper",
    "@types/synthetic-wrapper",
    "1.0.0",
    '/// <reference types="synthetic-core" />\nexport type { Marker } from "synthetic-core";\n',
  );
  const local = install(
    "node_modules/.pnpm/core/node_modules/@types/synthetic-core",
    "@types/synthetic-core",
    "2.0.0",
    core("local"),
  );
  fs.mkdirSync(path.join(root, "node_modules/@types"), { recursive: true });
  fs.symlinkSync(
    path.relative(path.join(root, "node_modules/@types"), path.dirname(wrapper)),
    path.join(root, "node_modules/@types/synthetic-wrapper"),
    "junction",
  );
  const peerRoot = path.dirname(path.dirname(wrapper));
  fs.symlinkSync(
    path.relative(peerRoot, path.dirname(local)),
    path.join(peerRoot, "synthetic-core"),
    "junction",
  );
}
