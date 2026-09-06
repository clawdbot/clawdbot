import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { BuildContext, UserConfig } from "tsdown";
import type ts from "typescript";
import { toErrorObject } from "./error-format.mts";

const withinRoot = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function findAncestorInstall(root: string, real: string): string | undefined {
  let ancestor = path.dirname(root);
  while (true) {
    const install = path.join(ancestor, "node_modules");
    if (withinRoot(install, real)) {
      return install;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return undefined;
    }
    ancestor = parent;
  }
}

export function createDeclarationInputBoundary(cwd: string) {
  const declared = path.resolve(cwd);
  const prefixes = [declared, fs.realpathSync(declared)];
  const root = fs.realpathSync.native(declared);
  // Node's symlink-resolved checkout can retain an OS alias that native realpath expands.
  // Translate only these checkout prefixes; never canonicalize outside candidates into scope.
  const resolve = (file: string) => {
    const absolute = path.resolve(declared, file);
    const prefix = prefixes.find((candidate) => withinRoot(candidate, absolute));
    return prefix ? path.resolve(root, path.relative(prefix, absolute)) : absolute;
  };
  return {
    root,
    resolve,
    assert(file: string) {
      const absolute = resolve(file);
      // Generated declaration IDs do not exist yet, but their source directory does.
      let existing = absolute;
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
        existing = path.dirname(existing);
      }
      const real = fs.realpathSync.native(existing);
      if (!withinRoot(root, absolute) || !withinRoot(root, real)) {
        // Hermetic declaration inputs must not inherit an ancestor install's exposed packages.
        const ancestorInstall = findAncestorInstall(root, real);
        const diagnosis = ancestorInstall
          ? `This checkout is nested inside another install at ${ancestorInstall}; module resolution walked out of the checkout and read a package from it. Run this lane in a checkout that is not nested inside another node_modules, or repair that ancestor install to the repository's isolated layout (nodeLinker: isolated in pnpm-workspace.yaml), which keeps transitive packages out of its root rather than exposing them to nested checkouts.`
          : `Install declaration dependencies inside ${root}; shared installs and external symlinks are unsupported.`;
        throw new Error(
          `Declaration input escapes checkout: ${absolute} -> ${real}. ${diagnosis} If the checkout is not nested inside another install, the compiled package imported a dependency it does not declare, which is the boundary violation this check exists to catch.`,
        );
      }
      return absolute;
    },
  };
}

export function resolveDeclarationInputCaptureModule() {
  const require = createRequire(import.meta.url);
  const fromTsdown = createRequire(require.resolve("tsdown"));
  return fromTsdown.resolve("rolldown-plugin-dts/tsc-context");
}

type ActiveBoundary = { root: string; users: number; failure?: Error; restore: () => void };
const activeSystems = new Map<ts.System, ActiveBoundary>();

function acquireDeclarationSystem(inputs: ReturnType<typeof createDeclarationInputBoundary>) {
  const { root, resolve } = inputs;
  // Use the compiler loaded by the declaration plugin, including its pnpm peer context.
  const require = createRequire(resolveDeclarationInputCaptureModule());
  const { sys }: typeof ts = require("typescript");
  let active = activeSystems.get(sys);
  if (active && active.root !== root) {
    throw new Error(`Concurrent declaration checkouts are unsupported: ${active.root} and ${root}`);
  }
  if (!active) {
    /* oxlint-disable typescript/unbound-method -- Keep raw identities for exact restoration of only owned methods; every delegated call below explicitly retains sys as its receiver. */
    const original = {
      getCurrentDirectory: sys.getCurrentDirectory,
      readFile: sys.readFile,
      fileExists: sys.fileExists,
      directoryExists: sys.directoryExists,
      getDirectories: sys.getDirectories,
      readDirectory: sys.readDirectory,
      realpath: sys.realpath,
    };
    /* oxlint-enable typescript/unbound-method */
    const boundary: ActiveBoundary = {
      root,
      users: 0,
      restore: () => Object.assign(sys, original),
    };
    const assert = (file: string) => {
      try {
        inputs.assert(file);
      } catch (error) {
        // CompilerHost catches read errors; buildEnd must still reject publication.
        boundary.failure ??= toErrorObject(error, "Declaration input boundary failed");
        throw error;
      }
    };
    const visible = (file: string) => {
      if (!withinRoot(root, file)) {
        return false;
      }
      assert(file);
      return true;
    };
    Object.assign(sys, {
      // Automatic types and relative filesystem calls must share the declared checkout.
      getCurrentDirectory: () => root,
      fileExists: (file) => {
        const absolute = resolve(file);
        return visible(absolute) && original.fileExists.call(sys, absolute);
      },
      directoryExists: (directory) => {
        const absolute = resolve(directory);
        return visible(absolute) && original.directoryExists.call(sys, absolute);
      },
      readFile: (file, encoding) => {
        const absolute = resolve(file);
        if (!withinRoot(root, absolute) && !original.fileExists.call(sys, absolute)) {
          return undefined;
        }
        assert(absolute);
        return original.readFile.call(sys, absolute, encoding);
      },
      realpath: (file) => {
        const absolute = resolve(file);
        assert(absolute);
        return original.realpath?.call(sys, absolute) ?? absolute;
      },
      getDirectories: (directory) => {
        const absolute = resolve(directory);
        return visible(absolute) ? original.getDirectories.call(sys, absolute) : [];
      },
      readDirectory: (directory, ...args) => {
        const absolute = resolve(directory);
        if (!visible(absolute)) {
          return [];
        }
        const files = original.readDirectory.call(sys, absolute, ...args);
        files.forEach(assert);
        return files;
      },
    } satisfies typeof original);
    active = boundary;
    activeSystems.set(sys, active);
  }
  active.users++;
  const boundary = active;
  return () => {
    if (--boundary.users === 0) {
      boundary.restore();
      activeSystems.delete(sys);
    }
    if (boundary.failure) {
      throw boundary.failure;
    }
  };
}

export function createDeclarationBoundaryHooks(existing?: UserConfig["hooks"]) {
  return async (hooks: BuildContext["hooks"]) => {
    if (typeof existing === "function") {
      await existing(hooks);
    } else if (existing) {
      hooks.addHooks(existing);
    }
    hooks.hook("build:prepare", prepareDeclarationBoundary);
  };
}

/** Resolve declaration overrides before constructing any format's bundler options. */
function prepareDeclarationBoundary({ options }: BuildContext) {
  if (!options.dts) {
    return;
  }
  // tsdown omits cwd when constructing the declaration plugin. Its entry globs
  // must match resolved source IDs, not an ambient cwd or Windows junction spelling.
  const declarationCwd = fs.realpathSync(options.dts.cwd ?? options.cwd);
  options.dts = { ...options.dts, cwd: declarationCwd };
  const boundary = createDeclarationBoundaryPlugin(options.cwd);
  // Keep this ahead of inputOptions callback plugins at equal hook priority.
  options.plugins = [options.plugins, boundary];
  if (options.format !== "cjs") {
    return;
  }
  // tsdown omits user plugins from its separate CJS declaration pass, created
  // after build:before. Its inputOptions callback still runs for that pass.
  const inputOptions = options.inputOptions;
  options.inputOptions = async (input, format, context) => {
    let resolved = input;
    if (typeof inputOptions === "function") {
      resolved = (await inputOptions(input, format, context)) ?? input;
    } else if (inputOptions) {
      const { mergeConfig } = await import("tsdown/config");
      resolved = mergeConfig({ inputOptions: input }, { inputOptions })
        .inputOptions as typeof input;
    }
    if (context.cjsDts) {
      resolved.plugins = [resolved.plugins, boundary];
    }
    return resolved;
  };
}

/** Scope compiler filesystem adaptation to bundling, never config import or writer snapshots. */
function createDeclarationBoundaryPlugin(cwd: string): NonNullable<UserConfig["plugins"]> {
  const inputs = createDeclarationInputBoundary(cwd);
  const releases: (() => void)[] = [];
  return {
    name: "openclaw-declaration-boundary",
    buildStart: {
      order: "pre",
      handler() {
        releases.push(acquireDeclarationSystem(inputs));
      },
    },
    load: {
      order: "pre",
      handler(id) {
        // OXC's declaration resolver has its own filesystem. Check its selected
        // declarations and sources before either Rolldown or the dts plugin loads them.
        if (path.isAbsolute(id) && /\.(?:[cm]?ts|tsx|json)$/u.test(id)) {
          inputs.assert(id);
        }
      },
    },
    buildEnd: {
      order: "post",
      handler() {
        releases.pop()?.();
      },
    },
  };
}
