import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type AnyNode } from "acorn";
import { createJiti } from "jiti";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../infra/path-guards.js";

const nativeModules = new Map<string, unknown>();
const nativeArtifacts = new Set<() => void>();
let nativeCleanupRegistered = false;

/** A disposable build artifact captures source, assets and declared dependency packages. */
export function capturePluginGenerationArtifact(rootDir: string, entryFile?: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "openclaw-plugin-build-")));
  fs.chmodSync(directory, 0o700);
  const packages = new Map<string, string>();
  const capturedPaths = new Map<string, string>();
  const nativeDigests = new Map<string, string>();
  const nativeViews = new Map<string, unknown>();
  const digest = createHash("sha256");
  const inputs = new Map<string, string>();
  const identity = (source: string) => {
    const stat = fs.statSync(source, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  const copyPackage = (sourceRoot: string, entry?: string): string => {
    const root = fs.realpathSync(sourceRoot);
    const existing = packages.get(root);
    if (existing) {
      return existing;
    }
    const packageId = `package-${packages.size}`;
    const moduleRoot = path.join(directory, packageId, "node_modules");
    const parentName = path.basename(path.dirname(root));
    const destination = path.join(
      moduleRoot,
      parentName.startsWith("@") ? parentName : "",
      path.basename(root),
    );
    digest.update(packageId).update("\0");
    packages.set(root, destination);
    const ancestors = new Set<string>();
    const copy = (source: string, target: string) => {
      const real = fs.realpathSync(source);
      if (!isPathInside(root, real)) {
        throw new Error(
          `Plugin source link leaves its package: ${path.relative(root, source)}. Declare shared code as a package dependency.`,
        );
      }
      const stat = fs.statSync(real);
      inputs.set(real, identity(real));
      capturedPaths.set(path.resolve(source), target);
      if (!capturedPaths.has(real)) {
        capturedPaths.set(real, target);
      }
      if (stat.isDirectory()) {
        if (ancestors.has(real)) {
          throw new Error(`Plugin source contains a directory cycle: ${source}`);
        }
        ancestors.add(real);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(real).toSorted()) {
          if (name !== "node_modules" && name !== ".git") {
            copy(path.join(source, name), path.join(target, name));
          }
        }
        ancestors.delete(real);
      } else if (stat.isFile()) {
        const opened = openRootFileSync({
          absolutePath: real,
          rootPath: root,
          boundaryLabel: "plugin build source",
          rejectHardlinks: false,
        });
        if (!opened.ok) {
          throw new Error(`Cannot capture plugin source ${source}`, { cause: opened.error });
        }
        try {
          const bytes = fs.readFileSync(opened.fd);
          digest
            .update(path.relative(destination, target))
            .update("\0")
            .update(String(bytes.length))
            .update("\0")
            .update(bytes);
          if (path.extname(target) === ".node") {
            nativeDigests.set(target, createHash("sha256").update(bytes).digest("hex"));
          }
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, bytes, { mode: 0o600 | (stat.mode & 0o100) });
        } finally {
          fs.closeSync(opened.fd);
        }
      } else {
        throw new Error(`Plugin build input is not a regular file: ${source}`);
      }
    };
    const references = new Set<string>();
    const scannedDirectories = new Set<string>();
    const captureFile = (source: string) => {
      if (capturedPaths.has(path.resolve(source))) {
        return;
      }
      const real = fs.realpathSync(source);
      if (!isPathInside(root, real)) {
        throw new Error("Standalone plugin input leaves its source directory");
      }
      if (fs.statSync(source).isDirectory()) {
        if (scannedDirectories.has(real)) {
          throw new Error("Standalone plugin input contains a directory cycle");
        }
        scannedDirectories.add(real);
        for (const name of fs.readdirSync(source).toSorted()) {
          if (name !== "node_modules" && name !== ".git") {
            captureFile(path.join(source, name));
          }
        }
        scannedDirectories.delete(real);
        return;
      }
      const target = path.join(destination, path.relative(root, source));
      copy(source, target);
      if (!/\.[cm]?[jt]sx?$/.test(source)) {
        return;
      }
      const resolver = createJiti(source, { fsCache: false, moduleCache: false, tryNative: false });
      const code = resolver.transform({
        source: fs.readFileSync(target, "utf8"),
        filename: source,
        ts: /\.[cm]?tsx?$/.test(source),
        async: true,
      });
      const captureReference = (value: string, module: boolean) => {
        if (module && !value.startsWith(".") && !path.isAbsolute(value)) {
          if (!isBuiltin(value)) {
            references.add(
              value.startsWith("@") ? value.split("/").slice(0, 2).join("/") : value.split("/")[0]!,
            );
          }
          return;
        }
        const local = path.resolve(path.dirname(source), value);
        if (!value || path.isAbsolute(value) || !isPathInside(root, local) || local === root) {
          return;
        }
        const resolved = module
          ? ((/\.[cm]?tsx?$/.test(source) && local.endsWith(".js")
              ? resolver.esmResolve(local.replace(/\.js$/, ".ts"), { try: true })
              : undefined) ?? resolver.esmResolve(local, { try: true }))
          : undefined;
        const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : (resolved ?? local);
        if (fs.existsSync(input)) {
          captureFile(input);
        }
      };
      const visit = (node: AnyNode) => {
        if (node.type === "CallExpression" || node.type === "NewExpression") {
          const { callee: call, arguments: args } = node;
          // Jiti emits named-import calls as (0, binding); their last expression is the callee.
          const callee = call.type === "SequenceExpression" ? call.expressions.at(-1)! : call;
          const member = callee.type === "MemberExpression" ? callee.property : callee;
          const name = member.type === "Identifier" ? member.name : "";
          const module =
            callee.type === "Identifier"
              ? ["require", "jitiImport", "jitiESMResolve"].includes(name)
              : callee.type === "MemberExpression" &&
                callee.object.type === "Identifier" &&
                callee.object.name === "require" &&
                name === "resolve";
          const asset =
            (node.type === "NewExpression" && name === "URL") ||
            ["readFile", "readFileSync", "createReadStream"].includes(name);
          // Trace module references and explicit asset reads. Ordinary strings
          // (labels, descriptions, prompts) never confer ownership of sibling files.
          if (
            (module || asset) &&
            args[0]?.type === "Literal" &&
            typeof args[0].value === "string"
          ) {
            captureReference(args[0].value, module);
          }
          if (
            callee.type === "MemberExpression" &&
            name === "join" &&
            args[0]?.type === "Identifier" &&
            args[0].name === "__dirname"
          ) {
            const parts = args
              .slice(1)
              .map((arg) =>
                arg.type === "Literal" && typeof arg.value === "string" ? arg.value : undefined,
              );
            if (parts.every((part) => part !== undefined)) {
              captureReference(path.join(...parts), false);
            }
          }
        }
        for (const child of Object.values(node).flat()) {
          if (child && typeof child === "object" && "type" in child) {
            // SAFETY: The tree comes directly from Acorn; typed child fields are Acorn nodes.
            visit(child as AnyNode);
          }
        }
      };
      visit(
        parse(code, {
          ecmaVersion: "latest",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
        }),
      );
    };
    if (entry) {
      captureFile(path.resolve(entry));
    } else {
      copy(root, destination);
    }
    const manifestPath = path.join(root, "package.json");
    if (!entry && !fs.existsSync(manifestPath)) {
      return destination;
    }
    const packageJson = entry
      ? {}
      : JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"));
    // SAFETY: Captured package.json supplies npm's optional dependency maps, read only for their keys.
    const manifest = packageJson as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const require = createRequire(manifestPath);
    const dependencyNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...references,
    ]);
    for (const name of [...dependencyNames].toSorted()) {
      // The documented SDK is injected by the host; copying it would create a second Gateway.
      if (name === "openclaw" || name === "@openclaw/plugin-sdk") {
        continue;
      }
      let dependencyRoot: string | undefined;
      // Declared dependencies use package lookup even when their name matches a Node builtin.
      for (const nodeModules of require.resolve.paths(`${name}/`) ?? []) {
        const candidate = path.join(nodeModules, name);
        if (fs.existsSync(path.join(candidate, "package.json"))) {
          dependencyRoot = candidate;
          break;
        }
      }
      if (!dependencyRoot) {
        if (
          name in (manifest.optionalDependencies ?? {}) ||
          name in (manifest.peerDependencies ?? {})
        ) {
          continue;
        }
        throw new Error(
          `Plugin dependency ${name} is missing from ${root}; install its dependencies and reload.`,
        );
      }
      const captured = copyPackage(dependencyRoot);
      // Preserve the normal sibling package layout used by native-addon loaders,
      // while each package's module directory owns its exact dependency versions.
      const sibling = path.join(moduleRoot, name);
      // Source directories can share a dependency's name. npm nests conflicting
      // packages so the dependency cannot replace its importing package.
      const link = sibling === destination ? path.join(destination, "node_modules", name) : sibling;
      fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
      fs.symlinkSync(path.relative(path.dirname(link), captured), link, "junction");
    }
    return destination;
  };
  try {
    const sourceRoot = fs.realpathSync(rootDir);
    const entry = entryFile ? fs.realpathSync(entryFile) : undefined;
    const root = copyPackage(sourceRoot, entry);
    if (entry && entryFile) {
      const alias = path.join(
        sourceRoot,
        path.relative(path.resolve(rootDir), path.resolve(entryFile)),
      );
      capturedPaths.set(alias, capturedPaths.get(entry)!);
    }
    for (const [source, before] of inputs) {
      if (identity(source) !== before) {
        throw new Error(
          "Plugin source changed while preparing its reload; retry after the edit finishes.",
        );
      }
    }
    let pinned = false;
    const remove = () => fs.rmSync(directory, { recursive: true, force: true });
    const resolveCaptured = (source: string) => {
      const lexical = path.resolve(source);
      const canonical = isPathInside(path.resolve(rootDir), lexical)
        ? path.join(sourceRoot, path.relative(path.resolve(rootDir), lexical))
        : lexical;
      const captured = capturedPaths.get(canonical);
      return captured && isPathInside(root, captured) ? captured : undefined;
    };
    return {
      sourceRoot,
      rootDir: root,
      boundaryRoot: directory,
      sourceDigest: digest.digest("hex"),
      hasSource: (source: string) => resolveCaptured(source) !== undefined,
      resolve: (source: string) => {
        // Public exports may be loaded for the first time after the original package
        // has been edited or removed. Resolve only through facts captured with it.
        const captured = resolveCaptured(source);
        if (!captured) {
          throw new Error("Plugin entry is outside its captured source package");
        }
        return captured;
      },
      loadNativeModule: (filename: string) => {
        const key = nativeDigests.get(filename);
        if (!key) {
          throw new Error("Native module is outside its captured dependency package");
        }
        if (nativeViews.has(key)) {
          return nativeViews.get(key);
        }
        // Node cannot unload native binaries. Reuse an immutable dependency ABI
        // across JS generations instead of dlopen'ing another copy on every edit.
        if (!nativeModules.has(key)) {
          nativeModules.set(key, createRequire(filename)(filename));
          pinned = true;
          nativeArtifacts.add(remove);
          if (!nativeCleanupRegistered) {
            nativeCleanupRegistered = true;
            process.once("exit", () => {
              for (const cleanup of nativeArtifacts) {
                cleanup();
              }
            });
          }
        }
        const native = nativeModules.get(key);
        // JS wrappers such as Koffi decorate native exports. Keep their closures
        // generation-local instead of retaining a retired realm in the ABI cache.
        const view =
          native && typeof native === "object"
            ? Object.create(Object.getPrototypeOf(native), Object.getOwnPropertyDescriptors(native))
            : native;
        nativeViews.set(key, view);
        return view;
      },
      dispose: () => {
        if (!pinned) {
          remove();
        }
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
