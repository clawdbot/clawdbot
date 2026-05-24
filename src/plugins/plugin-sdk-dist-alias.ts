import fs from "node:fs";
import path from "node:path";
import { tryReadJsonSync, writeJsonSync } from "../infra/json-files.js";

type OpenClawPackageJson = {
  exports?: Record<string, unknown>;
};

const PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK = [
  "codex-mcp-projection.js",
  "codex-native-task-runtime.js",
  `${["qa", "channel"].join("-")}.js`,
  `${["qa", "channel", "protocol"].join("-")}.js`,
  `${["qa", "lab"].join("-")}.js`,
  `${["qa", "runtime"].join("-")}.js`,
  "ssrf-runtime-internal.js",
  "test-utils.js",
] as const;

function isSafePluginSdkSubpathSegment(subpath: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}

function collectLegacyPublicPluginSdkDistFileNames(distRoot: string): Set<string> | undefined {
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return undefined;
  }
  const privateFileNames = readPrivateLocalOnlyPluginSdkDistFileNames(distRoot);
  const fileNames = new Set<string>();
  for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".js") {
      continue;
    }
    if (privateFileNames.has(entry.name)) {
      continue;
    }
    fileNames.add(entry.name);
  }
  return fileNames.size > 0 ? fileNames : undefined;
}

function readPrivateLocalOnlyPluginSdkDistFileNames(distRoot: string): Set<string> {
  const packageRoot = path.dirname(path.resolve(distRoot));
  const privateFileNames = new Set<string>(PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK);
  const subpaths = tryReadJsonSync(
    path.join(packageRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
  );
  if (!Array.isArray(subpaths)) {
    return privateFileNames;
  }
  for (const subpath of subpaths) {
    if (typeof subpath === "string" && isSafePluginSdkSubpathSegment(subpath)) {
      privateFileNames.add(`${subpath}.js`);
    }
  }
  return privateFileNames;
}

function readPublicPluginSdkDistFileNames(distRoot: string): Set<string> | undefined {
  const packageRoot = path.dirname(path.resolve(distRoot));
  const packageJson = tryReadJsonSync<OpenClawPackageJson>(path.join(packageRoot, "package.json"));
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return collectLegacyPublicPluginSdkDistFileNames(distRoot);
  }
  const packageExports = packageJson.exports;
  if (!packageExports || typeof packageExports !== "object" || Array.isArray(packageExports)) {
    return collectLegacyPublicPluginSdkDistFileNames(distRoot);
  }

  const fileNames = new Set<string>();
  for (const exportKey of Object.keys(packageExports)) {
    if (exportKey === "./plugin-sdk") {
      fileNames.add("index.js");
      continue;
    }
    if (!exportKey.startsWith("./plugin-sdk/")) {
      continue;
    }
    const subpath = exportKey.slice("./plugin-sdk/".length);
    if (isSafePluginSdkSubpathSegment(subpath)) {
      fileNames.add(`${subpath}.js`);
    }
  }

  return fileNames.size > 0 ? fileNames : collectLegacyPublicPluginSdkDistFileNames(distRoot);
}

function buildRuntimePluginSdkPackageExports(
  publicDistFileNames: ReadonlySet<string> | undefined,
): Record<string, string> {
  if (!publicDistFileNames) {
    return {
      "./plugin-sdk": "./plugin-sdk/index.js",
    };
  }

  const sortedFileNames = [...publicDistFileNames].toSorted((left, right) => {
    if (left === "index.js") {
      return -1;
    }
    if (right === "index.js") {
      return 1;
    }
    return left.localeCompare(right);
  });
  return Object.fromEntries(
    sortedFileNames.map((fileName) => {
      const subpath = fileName.slice(0, -".js".length);
      return [
        subpath === "index" ? "./plugin-sdk" : `./plugin-sdk/${subpath}`,
        `./plugin-sdk/${fileName}`,
      ];
    }),
  );
}

function removeStalePrivatePluginSdkAliasFiles(
  pluginSdkAliasDir: string,
  publicDistFileNames: ReadonlySet<string> | undefined,
): void {
  if (!publicDistFileNames || !fs.existsSync(pluginSdkAliasDir)) {
    return;
  }
  for (const entry of fs.readdirSync(pluginSdkAliasDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".js") {
      continue;
    }
    if (!publicDistFileNames.has(entry.name)) {
      fs.rmSync(path.join(pluginSdkAliasDir, entry.name), { force: true });
    }
  }
}

function writeRuntimeJsonFile(targetPath: string, value: unknown): void {
  writeJsonSync(targetPath, value);
}

function writeRuntimeModuleWrapper(sourcePath: string, targetPath: string): void {
  const relative = `./${path.relative(path.dirname(targetPath), sourcePath).split(path.sep).join("/")}`;
  const content = [`export * from ${JSON.stringify(relative)};`, ""].join("\n");
  try {
    if (fs.readFileSync(targetPath, "utf8") === content) {
      return;
    }
  } catch {
    // Missing or unreadable wrapper; rewrite below.
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

export function ensureOpenClawPluginSdkAlias(distRoot: string): void {
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const publicDistFileNames = readPublicPluginSdkDistFileNames(distRoot);
  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  const pluginSdkAliasDir = path.join(aliasDir, "plugin-sdk");
  writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: buildRuntimePluginSdkPackageExports(publicDistFileNames),
  });
  try {
    if (fs.existsSync(pluginSdkAliasDir) && !fs.lstatSync(pluginSdkAliasDir).isDirectory()) {
      fs.rmSync(pluginSdkAliasDir, { recursive: true, force: true });
    }
  } catch {
    // Another process may be creating the alias at the same time.
  }
  fs.mkdirSync(pluginSdkAliasDir, { recursive: true });
  removeStalePrivatePluginSdkAliasFiles(pluginSdkAliasDir, publicDistFileNames);
  for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".js") {
      continue;
    }
    if (publicDistFileNames && !publicDistFileNames.has(entry.name)) {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, entry.name),
      path.join(pluginSdkAliasDir, entry.name),
    );
  }
}
