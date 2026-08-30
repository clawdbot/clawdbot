import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { valid } from "semver";
import * as tar from "tar";
import { collectPackageDistImportErrors } from "../../../scripts/lib/package-dist-imports.mjs";
import { validateBundledPackageDependencyAlignment } from "../../../scripts/package-source-dependencies.mjs";
import {
  collectPackageDistInventory,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../../infra/package-dist-inventory.js";
import {
  composePackagePlugins,
  type DistributionPackageManifest,
} from "../../infra/package-plugin-composition.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleArchiveManifest,
  readWorkerBundleDirectoryManifest,
} from "../../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../../shared/worker-bundle-hash.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";

const INSTALL_GUARD_PATH = "dist/openclaw-install-guard";
const BOOTSTRAP_LAUNCHER_FILES = ["openclaw.mjs", "node-version.mjs"];
const IGNORED_PLUGIN_DIRECTORIES = new Set(["node_modules", "src", "test", "tests"]);
const METADATA_KEYS = [
  "name",
  "version",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
] as const;

type NodePackageManifest = DistributionPackageManifest & {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bundleDependencies?: string[];
  bundledDependencies?: string[];
  openclaw?: { extensions?: string[]; runtimeExtensions?: string[] };
};

export type NodeBootstrapArtifact = Readonly<{
  tarballPath: string;
  tarballSha256: string;
  tarballBytes: number;
  openclawVersion: string;
  buildId: string;
  enabledPluginIds: readonly string[];
}>;

type ArtifactOptions = {
  packageRoot: string;
  runningBuildId: string | null;
  plugins: readonly { id: string; root: string }[];
};

function bootstrapPath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe node distribution path: ${value}`);
  }
  return value;
}

async function readPackageManifest(root: string): Promise<NodePackageManifest> {
  const value = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ) as NodePackageManifest; // SAFETY: trusted installation metadata; identity, pins and import closure are checked before publication.
  if (!value.name || valid(value.version) !== value.version) {
    throw new Error("Node distribution requires a named package with an exact version");
  }
  return value;
}

function requireRunningBuild(options: ArtifactOptions, text: string, version: string): string {
  // SAFETY: fields remain unknown until matched against the process's immutable build identity below.
  const info = JSON.parse(text) as { buildId?: unknown; version?: unknown };
  if (
    !options.runningBuildId ||
    info.buildId !== options.runningBuildId ||
    info.version !== version
  ) {
    throw new Error(
      "Cloud bootstrap requires the running Gateway build; run pnpm build and restart the Gateway before provisioning",
    );
  }
  return options.runningBuildId;
}

function assertBuiltImportClosure(root: string, files: string[], label: string): void {
  const errors = collectPackageDistImportErrors({
    files,
    readText: (relative) => readFileSync(path.join(root, relative), "utf8"),
  });
  if (errors.length > 0) {
    throw new Error(
      `Node distribution ${label} has an incomplete built import closure; rebuild and restart the Gateway: ${errors.slice(0, 5).join("; ")}`,
    );
  }
}

async function resolvePlugins(options: ArtifactOptions, packageRoot: string) {
  const ids = new Set<string>();
  return await Promise.all(
    options.plugins.map(async ({ id, root }) => {
      if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id) || ids.has(id)) {
        throw new Error(`Invalid or duplicate node bootstrap plugin: ${id}`);
      }
      ids.add(id);
      const requestedRoot = await fs.realpath(root);
      const sourceRoot = path.join(packageRoot, "extensions", id);
      const bundledRoot = path.join(packageRoot, "dist", "extensions", id);
      const builtRoot = requestedRoot === sourceRoot ? bundledRoot : requestedRoot;
      const packageJson = await readPackageManifest(builtRoot);
      if (requestedRoot === sourceRoot) {
        const sourcePackage = await readPackageManifest(sourceRoot);
        if (METADATA_KEYS.some((key) => !isDeepStrictEqual(packageJson[key], sourcePackage[key]))) {
          throw new Error(
            `Built plugin ${id} does not match source metadata; rebuild and restart the Gateway`,
          );
        }
      }
      const manifest = JSON.parse(
        await fs.readFile(path.join(builtRoot, "openclaw.plugin.json"), "utf8"),
      ) as { id?: unknown }; // SAFETY: the unknown id is checked against the trusted registry below.
      if (manifest.id !== id) {
        throw new Error(`Node bootstrap plugin identity does not match ${id}`);
      }
      const entries = packageJson.openclaw?.runtimeExtensions ?? packageJson.openclaw?.extensions;
      if (!entries?.length) {
        throw new Error(`Node bootstrap plugin ${id} has no runtime entry`);
      }
      for (const entry of entries) {
        const relative = bootstrapPath(entry.replace(/^\.\//u, "").replace(/\.ts$/u, ".js"));
        await fs.access(path.join(builtRoot, relative));
      }
      return { id, root: builtRoot, packageJson, bundled: builtRoot === bundledRoot };
    }),
  );
}

async function prepareNodeBootstrapArtifact(
  options: ArtifactOptions,
  temporaryRoot: string,
): Promise<NodeBootstrapArtifact> {
  const packageRoot = await fs.realpath(options.packageRoot);
  const sourcePackage = await readPackageManifest(packageRoot);
  if (sourcePackage.name !== "openclaw") {
    throw new Error("Node bootstrap requires the running OpenClaw package root");
  }
  const buildInfoPath = path.join(packageRoot, "dist", "build-info.json");
  const buildInfo = await fs.readFile(buildInfoPath, "utf8").catch((cause: unknown) => {
    throw new Error(
      "Cloud bootstrap requires a built Gateway; run pnpm build and restart the Gateway before provisioning",
      { cause },
    );
  });
  const buildId = requireRunningBuild(options, buildInfo, sourcePackage.version);
  const plugins = await resolvePlugins(options, packageRoot);
  const packageJson = composePackagePlugins(sourcePackage, plugins);
  const stagingRoot = path.join(temporaryRoot, "package");
  await fs.mkdir(stagingRoot, { mode: 0o700 });
  const staged = new Set<string>();
  let expandedBytes = 0;

  const writeFile = async (relative: string, contents: Buffer | string, executable = false) => {
    bootstrapPath(relative);
    expandedBytes += Buffer.byteLength(contents);
    if (
      staged.size >= DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxEntries ||
      expandedBytes > DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxExpandedBytes
    ) {
      throw new Error("Node bootstrap distribution exceeds its artifact limits");
    }
    const target = path.join(stagingRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, contents, { mode: executable ? 0o755 : 0o644 });
    staged.add(relative);
  };
  const copyFile = async (root: string, relative: string, destination = relative) => {
    bootstrapPath(relative);
    const source = path.join(root, relative);
    if ((await fs.realpath(source)) !== source) {
      throw new Error(`Node distribution cannot contain symbolic links: ${relative}`);
    }
    const handle = await fs.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.size > DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxExpandedBytes - expandedBytes
      ) {
        throw new Error(`Invalid node distribution file: ${relative}`);
      }
      const contents = await handle.readFile();
      const after = await handle.stat();
      const current = await fs.lstat(source);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        (await fs.realpath(source)) !== source
      ) {
        throw new Error(`Node distribution changed while packaging: ${relative}`);
      }
      await writeFile(destination, contents, (before.mode & 0o111) !== 0);
    } finally {
      await handle.close();
    }
  };

  const externalPluginPrefixes = plugins
    .filter((plugin) => !plugin.bundled)
    .map(({ id }) => `dist/extensions/${id}/`);
  const files = (
    await collectPackageDistInventory(packageRoot, { packageManifest: packageJson })
  ).filter((relative) => !externalPluginPrefixes.some((prefix) => relative.startsWith(prefix)));
  if (!files.includes("dist/entry.js") && !files.includes("dist/entry.mjs")) {
    throw new Error(
      "Cloud bootstrap is missing its built CLI entry; run pnpm build and restart the Gateway",
    );
  }
  for (const relative of [...BOOTSTRAP_LAUNCHER_FILES, ...files]) {
    if (relative !== INSTALL_GUARD_PATH) {
      await copyFile(packageRoot, relative);
    }
  }
  for (const relative of sourcePackage.files ?? []) {
    if (relative.startsWith("scripts/") && !relative.includes("*") && !relative.endsWith("/")) {
      await copyFile(packageRoot, relative);
    }
  }
  // Keep real install guards/pruning, but source-only prepare/prepack commands must not run on a node.
  packageJson.scripts = Object.fromEntries(
    Object.entries(packageJson.scripts ?? {}).filter(([name]) =>
      ["preinstall", "install", "postinstall"].includes(name),
    ),
  );
  delete packageJson.devDependencies;
  for (const plugin of plugins) {
    if (plugin.bundled) {
      continue;
    }
    const visit = async (directory: string, relativeRoot = ""): Promise<void> => {
      for (const child of await fs.readdir(directory, { withFileTypes: true })) {
        if (child.name.startsWith(".") || IGNORED_PLUGIN_DIRECTORIES.has(child.name)) {
          continue;
        }
        const relative = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
        if (relative.split("/").length > 64) {
          throw new Error("Node bootstrap plugin exceeds its directory depth limit");
        }
        if (child.isDirectory()) {
          await visit(path.join(directory, child.name), relative);
        } else if (/\.(?:[cm]?js|json|wasm)$/u.test(child.name)) {
          await copyFile(plugin.root, relative, `dist/extensions/${plugin.id}/${relative}`);
        }
      }
    };
    await visit(plugin.root);
  }

  // Only declared bundled/workspace packages cross as JavaScript artifacts. Native dependencies
  // remain exact npm pins, so the destination chooses its own OS/CPU optional packages.
  const bundledNames = new Set([
    ...(packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? []),
    ...Object.entries(packageJson.dependencies ?? {})
      .filter(([, spec]) => spec.startsWith("workspace:"))
      .map(([name]) => name),
  ]);
  for (const name of [...bundledNames].toSorted()) {
    bootstrapPath(name);
    const root = await fs.realpath(path.join(packageRoot, "node_modules", name));
    const bundled = await readPackageManifest(root);
    if (bundled.name !== name) {
      throw new Error(`Bundled node distribution dependency identity does not match ${name}`);
    }
    const dependencies = validateBundledPackageDependencyAlignment({
      bundledDependencies: bundled.dependencies,
      bundledPackageLabel: `bundled ${name}`,
      rootDependencies: packageJson.dependencies,
    });
    for (const [dependency, version] of dependencies) {
      packageJson.dependencies![dependency] = version;
    }
    const bundledFiles = await collectPackageDistInventory(root);
    if (bundledFiles.length === 0) {
      throw new Error(
        `Bundled node dependency ${name} needs its compiled distribution; rebuild the Gateway`,
      );
    }
    for (const relative of bundledFiles) {
      await copyFile(root, relative, `node_modules/${name}/${relative}`);
    }
    delete bundled.dependencies;
    delete bundled.devDependencies;
    delete bundled.scripts;
    await writeFile(`node_modules/${name}/package.json`, `${JSON.stringify(bundled, null, 2)}\n`);
    assertBuiltImportClosure(
      path.join(stagingRoot, "node_modules", name),
      ["package.json", ...bundledFiles],
      name,
    );
    packageJson.dependencies![name] = bundled.version;
  }
  packageJson.bundleDependencies = [...bundledNames].toSorted();
  delete packageJson.bundledDependencies;
  for (const [name, spec] of Object.entries({
    ...packageJson.optionalDependencies,
    ...packageJson.dependencies,
  })) {
    if (valid(spec) !== spec) {
      throw new Error(`Node distribution requires an exact dependency pin: ${name}@${spec}`);
    }
  }
  await writeFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  const inventory = [...staged].filter((entry) => entry.startsWith("dist/")).toSorted();
  await writeFile(PACKAGE_DIST_INVENTORY_RELATIVE_PATH, `${JSON.stringify(inventory)}\n`);
  await writeFile(INSTALL_GUARD_PATH, "OpenClaw package preinstall has not completed.\n");
  assertBuiltImportClosure(stagingRoot, [...staged], packageJson.name);
  if (
    (await fs.readFile(buildInfoPath, "utf8")) !== buildInfo ||
    !isDeepStrictEqual(await readPackageManifest(packageRoot), sourcePackage)
  ) {
    throw new Error(
      "Gateway build changed while preparing cloud bootstrap; restart the Gateway and retry",
    );
  }
  const tarballPath = path.join(temporaryRoot, "node-runtime.tgz");
  const manifest = await readWorkerBundleDirectoryManifest({
    root: temporaryRoot,
    limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  });
  await tar.create(
    {
      cwd: temporaryRoot,
      file: tarballPath,
      gzip: true,
      noDirRecurse: true,
      noMtime: true,
      portable: true,
      strict: true,
    },
    manifest.map((entry) => entry.path),
  );
  const tarballBytes = (await fs.stat(tarballPath)).size;
  if (tarballBytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
    throw new Error("Node bootstrap archive exceeds the transfer limit");
  }
  const archiveManifest = await readWorkerBundleArchiveManifest(
    tarballPath,
    DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  );
  if (hashWorkerBundleManifest(manifest) !== hashWorkerBundleManifest(archiveManifest)) {
    throw new Error("Node bootstrap archive does not match the staged distribution");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(tarballPath)) {
    hash.update(chunk);
  }
  await fs.rm(stagingRoot, { recursive: true, force: true });
  return Object.freeze({
    tarballPath,
    tarballSha256: hash.digest("hex"),
    tarballBytes,
    openclawVersion: packageJson.version,
    buildId,
    enabledPluginIds: Object.freeze(plugins.map(({ id }) => id).toSorted()),
  });
}

/** Owns one immutable deployment artifact for this Gateway process, never the live installation. */
export function createNodeBootstrapArtifactProvider(options: ArtifactOptions) {
  let prepared: Promise<NodeBootstrapArtifact> | undefined;
  let temporaryRoot: string | undefined;
  let closed = false;
  const consumers = new Map<AbortSignal, Promise<void>>();
  return {
    async prepare(signal?: AbortSignal): Promise<NodeBootstrapArtifact> {
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Node bootstrap artifact provider is closed");
      }
      prepared ??= (async () => {
        try {
          temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-runtime-"));
          if (closed) {
            throw new Error("Node bootstrap artifact provider is closed");
          }
          const artifact = await prepareNodeBootstrapArtifact(options, temporaryRoot);
          if (closed) {
            throw new Error("Node bootstrap artifact provider is closed");
          }
          return artifact;
        } catch (error) {
          if (temporaryRoot) {
            await fs.rm(temporaryRoot, { recursive: true, force: true });
          }
          temporaryRoot = undefined;
          prepared = undefined;
          throw error;
        }
      })();
      const artifact = await prepared;
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Node bootstrap artifact provider is closed");
      }
      // A registry reload retires the producer, but an admitted enrollment still owns
      // its artifact until that enrollment's authority closes.
      if (signal && !consumers.has(signal)) {
        consumers.set(
          signal,
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                consumers.delete(signal);
                resolve();
              },
              { once: true },
            );
          }),
        );
      }
      return artifact;
    },
    async close(): Promise<void> {
      closed = true;
      await prepared?.catch(() => undefined);
      await Promise.all(consumers.values());
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
        temporaryRoot = undefined;
      }
    },
  };
}
