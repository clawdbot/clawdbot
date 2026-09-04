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

export function assertDeclarationInput(root: string, file: string) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  // Generated declaration IDs do not exist yet, but their source directory does.
  let existing = absolute;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  const real = fs.realpathSync(existing);
  if (!withinRoot(root, absolute) || !withinRoot(root, real)) {
    throw new Error(
      `Declaration input escapes checkout: ${absolute} -> ${real}. Install declaration dependencies inside ${root}; shared installs and external symlinks are unsupported.`,
    );
  }
}

export function resolveDeclarationInputCaptureModule() {
  const require = createRequire(import.meta.url);
  const fromTsdown = createRequire(require.resolve("tsdown"));
  return fromTsdown.resolve("rolldown-plugin-dts/tsc-context");
}

type ActiveBoundary = { root: string; users: number; failure?: Error; restore: () => void };
const activeSystems = new Map<ts.System, ActiveBoundary>();

function acquireDeclarationSystem(root: string) {
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
        assertDeclarationInput(root, file);
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
        const absolute = path.resolve(root, file);
        return visible(absolute) && original.fileExists.call(sys, absolute);
      },
      directoryExists: (directory) => {
        const absolute = path.resolve(root, directory);
        return visible(absolute) && original.directoryExists.call(sys, absolute);
      },
      readFile: (file, encoding) => {
        const absolute = path.resolve(root, file);
        if (!withinRoot(root, absolute) && !original.fileExists.call(sys, absolute)) {
          return undefined;
        }
        assert(absolute);
        return original.readFile.call(sys, absolute, encoding);
      },
      realpath: (file) => {
        const absolute = path.resolve(root, file);
        assert(absolute);
        return original.realpath?.call(sys, absolute) ?? absolute;
      },
      getDirectories: (directory) => {
        const absolute = path.resolve(root, directory);
        return visible(absolute) ? original.getDirectories.call(sys, absolute) : [];
      },
      readDirectory: (directory, ...args) => {
        const absolute = path.resolve(root, directory);
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

export function createDeclarationBoundaryHooks(
  existing?: UserConfig["hooks"],
): NonNullable<UserConfig["hooks"]> {
  if (typeof existing === "function") {
    return async (hooks) => {
      await existing(hooks);
      hooks.hook("build:prepare", prepareDeclarationBoundary);
    };
  }
  return {
    ...existing,
    "build:prepare": async (context) => {
      await existing?.["build:prepare"]?.(context);
      prepareDeclarationBoundary(context);
    },
  };
}

/** Resolve declaration overrides before constructing any format's bundler options. */
function prepareDeclarationBoundary({ options }: BuildContext) {
  if (!options.dts) {
    return;
  }
  const boundary = createDeclarationBoundaryPlugin(options.cwd);
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
  const root = fs.realpathSync(cwd);
  const releases: (() => void)[] = [];
  return {
    name: "openclaw-declaration-boundary",
    buildStart: {
      order: "pre",
      handler() {
        releases.push(acquireDeclarationSystem(root));
      },
    },
    load: {
      order: "pre",
      handler(id) {
        // OXC's declaration resolver has its own filesystem. Check its selected
        // declarations and sources before either Rolldown or the dts plugin loads them.
        if (path.isAbsolute(id) && /\.(?:[cm]?ts|tsx|json)$/u.test(id)) {
          assertDeclarationInput(root, id);
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
