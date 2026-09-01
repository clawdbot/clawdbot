import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  listCacheFiles,
  type ArtifactRecord,
} from "./build-artifact-cache.mts";

type CompilerInputPolicy = {
  toolchainFiles: string[];
  generatorInputs: string[];
  isGeneratorInput?: (file: string) => boolean;
};
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** One phase owns all byte reads; freshness never trusts persisted timestamps. */
export class CompilerInputSnapshot {
  private readonly files = new Map<string, { bytes: Buffer; hash: string; ctimeMs: number }>();
  private readonly configs = new Map<
    string,
    { files: string[]; roots: string[]; options: ts.CompilerOptions }
  >();
  private topology?: { name: string; directory: string; file?: string }[];
  private generatorInputs?: string[];
  private readonly policy: CompilerInputPolicy;
  private tools?: string;
  readonly rootDir: string;
  constructor(rootDir: string, policy: CompilerInputPolicy) {
    this.rootDir = rootDir;
    this.policy = policy;
  }

  private read(file: string) {
    const absolute = path.resolve(this.rootDir, file);
    let entry = this.files.get(absolute);
    if (!entry) {
      const before = fs.statSync(absolute);
      const bytes = fs.readFileSync(absolute);
      const after = fs.statSync(absolute);
      if (
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== after.ino ||
        before.size !== after.size
      ) {
        throw new Error(`Boundary input changed while reading: ${file}`);
      }
      entry = { bytes, hash: digest(bytes), ctimeMs: after.ctimeMs };
      this.files.set(absolute, entry);
    }
    return entry;
  }

  hash = (file: string) => this.read(file).hash;

  private config(file: string) {
    let result = this.configs.get(file);
    if (!result) {
      const files = new Set<string>();
      const parsed = ts.getParsedCommandLineOfConfigFile(
        path.resolve(this.rootDir, file),
        {},
        {
          ...ts.sys,
          readFile: (name) => {
            files.add(name);
            try {
              return this.read(name).bytes.toString("utf8");
            } catch {
              return undefined;
            }
          },
          onUnRecoverableConfigFileDiagnostic: (error) => {
            throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
          },
        },
      );
      if (!parsed || parsed.errors.length) {
        throw new Error(
          `Invalid boundary config ${file}: ${parsed?.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n")}`,
        );
      }
      result = { files: [...files], roots: parsed.fileNames.toSorted(), options: parsed.options };
      this.configs.set(file, result);
    }
    return result;
  }

  private namespace(outputRoot?: string) {
    if (this.topology === undefined) {
      const names: { name: string; directory: string; file?: string }[] = [];
      const visited = new Map<string, boolean>();
      const active = new Set<string>();
      const visit = (directory: string, realDirectory: string, installed = false) => {
        if (
          active.has(realDirectory) ||
          visited.get(realDirectory) === true ||
          (!installed && visited.has(realDirectory))
        ) {
          return;
        }
        // A local alias may precede an installed package, whose dist must count.
        // Upgrade that traversal once; active ancestors still fence link cycles.
        visited.set(realDirectory, installed);
        active.add(realDirectory);
        const add = (name: string, file?: string) =>
          names.push({ name, directory: realDirectory, file });
        const entries = fs
          .readdirSync(realDirectory, { withFileTypes: true })
          .toSorted((left, right) => (left.name < right.name ? -1 : 1));
        for (const entry of entries) {
          const file = path.join(directory, entry.name);
          const canonicalFile = path.join(realDirectory, entry.name);
          const id = portableRelativePath(this.rootDir, file);
          // Native PR and workflow helper checkouts are separate roots; aliases retain their paths.
          if (
            id === ".ci-harness" ||
            id === ".worktrees" ||
            (!installed &&
              [".git", ".artifacts", ".claude", ".agents", ".local", "dist"].includes(entry.name))
          ) {
            continue;
          }
          // Tool scratch (.vite-temp bundles, jiti/vitest caches) churns under
          // installed roots while sibling tasks run and would flip the topology
          // digest mid-compile. Resolution never enters dot-entries except .pnpm.
          if (installed && entry.name !== ".pnpm" && entry.name.startsWith(".")) {
            continue;
          }
          if (
            /^extensions\/[^/]+\/(?:__rootdir_boundary_canary__\.ts|tsconfig\.rootdir-canary\.json)$/u.test(
              id,
            )
          ) {
            continue;
          }
          let isDirectory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            // Resolve entries beneath the parent we enumerated. Windows relative
            // links reached through a junction can otherwise follow a different alias.
            add(`${id}->${fs.readlinkSync(canonicalFile)}`);
            try {
              isDirectory = fs.statSync(canonicalFile).isDirectory();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
              add(`${id}:missing`);
              continue;
            }
            add(`${id}:${isDirectory ? "directory" : "file"}`);
          }
          if (isDirectory) {
            // Extend the canonical parent path for ordinary children; resolve only links.
            // Rewalking every ancestor multiplies metadata calls across installed trees.
            const canonical = entry.isSymbolicLink()
              ? fs.realpathSync(canonicalFile)
              : canonicalFile;
            visit(file, canonical, installed || entry.name === "node_modules");
          } else if (/\.(?:[cm]?[jt]sx?|json)$/u.test(entry.name)) {
            add(id, canonicalFile);
          }
        }
        active.delete(realDirectory);
      };
      // A failed lookup can be outside declared roots. Name/existence changes in
      // the local resolution namespace invalidate conservatively; unrelated byte
      // edits do not. Installed package contents are included, not just lockfiles.
      visit(this.rootDir, fs.realpathSync(this.rootDir));
      this.topology = names.toSorted((left, right) => (left.name < right.name ? -1 : 1));
    }
    // Workspace aliases can expose this producer's outputs as installed inputs.
    // Keep their link identities, and retain the same subtree for other consumers.
    return digest(
      this.topology
        .filter(
          ({ directory }) =>
            !outputRoot ||
            (directory !== outputRoot && !directory.startsWith(`${outputRoot}${path.sep}`)),
        )
        .map(({ name }) => name)
        .join("\0"),
    );
  }

  private toolInputs() {
    this.namespace();
    this.generatorInputs ??= [
      ...new Set([
        ...this.policy.generatorInputs.filter((file) =>
          fs.existsSync(path.resolve(this.rootDir, file)),
        ),
        ...(this.topology ?? []).flatMap(({ name, file }) =>
          file && this.policy.isGeneratorInput?.(name) ? [file] : [],
        ),
      ]),
    ].toSorted();
    return [...this.policy.toolchainFiles, ...this.generatorInputs];
  }

  private toolchain() {
    this.tools ??= digest(
      JSON.stringify([
        process.versions.node,
        process.platform,
        process.arch,
        ...this.toolInputs().map((file) => this.hash(file)),
      ]),
    );
    return this.tools;
  }

  signature(config: string, args: string[], inputs: string[], outputRoot?: string) {
    const parsed = this.config(config);
    return digest(
      JSON.stringify(
        [
          ARTIFACT_CACHE_VERSION,
          this.namespace(outputRoot),
          outputRoot,
          this.toolchain(),
          config,
          args,
          parsed.options,
          parsed.roots.map((file) => portableRelativePath(this.rootDir, file)),
          parsed.files.map((file) => [portableRelativePath(this.rootDir, file), this.hash(file)]),
          inputs.map((file) => [file, this.hash(file)]),
        ],
        (_key, value: unknown) => {
          // TypeScript config paths use forward slashes even on Windows.
          const normalized = typeof value === "string" ? path.normalize(value) : value;
          return normalized === this.rootDir
            ? "."
            : typeof normalized === "string" && normalized.startsWith(`${this.rootDir}${path.sep}`)
              ? portableRelativePath(this.rootDir, normalized)
              : value;
        },
      ),
    );
  }

  matches(
    record: ArtifactRecord | undefined,
    config: string,
    args: string[],
    required: string[],
    outputRoot?: string,
  ) {
    try {
      return (
        record?.inputs !== undefined &&
        record.signature === this.signature(config, args, record.inputs, outputRoot) &&
        required.every((file) => Object.hasOwn(record.outputs, file)) &&
        (!outputRoot ||
          listCacheFiles(
            this.rootDir,
            [{ path: outputRoot, extensions: [".d.ts", ".d.mts", ".d.cts"] }],
            fs,
          ).every((file) =>
            Object.hasOwn(record.outputs, portableRelativePath(this.rootDir, file)),
          )) &&
        Object.entries(record.outputs).every(([file, hash]) => this.hash(file) === hash)
      );
    } catch {
      return false;
    }
  }

  /** Seal only successful compiler membership after its joined invocation. */
  seal(
    config: string,
    args: string[],
    inputs: string[],
    before: CompilerInputSnapshot,
    startedAt: number,
    outputRoot?: string,
  ) {
    const signature = this.signature(config, args, inputs, outputRoot);
    if (
      before.namespace(outputRoot) !== this.namespace(outputRoot) ||
      before.toolchain() !== this.toolchain() ||
      JSON.stringify(before.config(config)) !== JSON.stringify(this.config(config)) ||
      before.config(config).files.some((file) => before.hash(file) !== this.hash(file))
    ) {
      throw new Error("Boundary configuration or resolution topology changed during compilation");
    }
    for (const file of [...inputs, ...this.config(config).files, ...this.toolInputs()]) {
      const current = this.read(file);
      const previous = before.files.get(path.resolve(this.rootDir, file));
      // ctime is an invocation-only mutation fence, never a cache key or a warm
      // acceptance path. It covers newly discovered inputs (including manifests)
      // without assuming native XXH3 versions are SHA256 digests of disk bytes.
      if (current.ctimeMs >= startedAt || (previous && previous.hash !== current.hash)) {
        throw new Error(`Boundary input changed during compilation: ${file}`);
      }
    }
    return {
      signature,
      inputs,
    };
  }
}
