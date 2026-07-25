/**
 * Config includes: $include directive for modular configs
 *
 * @example
 * ```json5
 * {
 *   "$include": "./base.json5",           // single file
 *   "$include": ["./a.json5", "./b.json5"] // merge multiple
 * }
 * ```
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { canUseRootFileOpen, openRootFileSync } from "../infra/boundary-file-read.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { mergeDeep as mergeDeepValues } from "../infra/deep-merge.js";
import { isPathInside } from "../security/scan-paths.js";
import { isPlainObject } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;
const MAX_INCLUDE_FILE_BYTES = 2 * 1024 * 1024;

/** Maximum length for $include path and resolved path (CWE-22 hardening). */
const MAX_INCLUDE_PATH_LENGTH = 4096;

export function hashConfigIncludeRaw(raw: string | null): string {
  const hash = crypto.createHash("sha256");
  if (raw === null) {
    hash.update("missing");
  } else {
    hash.update("present\0");
    hash.update(raw, "utf-8");
  }
  return hash.digest("hex");
}

/** Resolve an include write target through its current ancestors and allowed roots. */
export function resolveConfigIncludeWritePath(params: {
  configPath: string;
  includePath: string;
  allowedRoots?: readonly string[];
}): string {
  const resolvedPath = path.normalize(path.resolve(params.includePath));
  const roots = [path.dirname(params.configPath), ...(params.allowedRoots ?? [])]
    .filter((root) => path.isAbsolute(root))
    .map((root) => path.normalize(root));
  if (!roots.some((root) => isPathInside(root, resolvedPath))) {
    throw new ConfigIncludeError(
      `Include write path escapes config directory: ${params.includePath}`,
      params.includePath,
    );
  }

  const canonicalPath = path.normalize(resolvePathViaExistingAncestorSync(resolvedPath));
  const realRoots = roots.map((root) => path.normalize(safeRealpath(root)));
  if (!realRoots.some((root) => isPathInside(root, canonicalPath))) {
    throw new ConfigIncludeError(
      `Include write path resolves outside config directory (symlink): ${params.includePath}`,
      params.includePath,
    );
  }
  return canonicalPath;
}

// ============================================================================
// Types
// ============================================================================

export type IncludeResolver = {
  readFile: (path: string) => string;
  readFileWithGuards?: (params: IncludeFileReadParams) => string;
  parseJson: (raw: string) => unknown;
  /** Reports lexically contained paths before canonical/open checks for watcher repair flows. */
  onLexicalPath?: (resolvedPath: string) => void;
  /** Reports the resolved value contributed by an include at its logical config path. */
  onIncludeResolved?: (event: { path: readonly string[]; value: unknown }) => void;
};

type IncludeFileReadParams = {
  includePath: string;
  resolvedPath: string;
  rootRealDir: string;
  ioFs?: typeof fs;
  maxBytes?: number;
  onResolvedPath?: (resolvedPath: string) => void;
};

type IncludeRoot = {
  rootDir: string;
  rootRealDir: string;
};

type IncludeBoundary = {
  readonly configRoot: IncludeRoot;
  readonly allowedRoots: ReadonlyArray<IncludeRoot>;
};

type ResolveConfigIncludesOptions = {
  /**
   * Additional directories outside the config directory that `$include` paths
   * may resolve into. Typically populated from `OPENCLAW_INCLUDE_ROOTS`.
   * Each entry must be an absolute path; symlinks are resolved before the
   * containment check, consistent with the config-directory boundary check.
   */
  allowedRoots?: ReadonlyArray<string>;
};

// ============================================================================
// Errors
// ============================================================================

export class ConfigIncludeError extends Error {
  constructor(
    message: string,
    public readonly includePath: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = "ConfigIncludeError";
  }
}

export class CircularIncludeError extends ConfigIncludeError {
  constructor(public readonly chain: string[]) {
    super(
      `Circular include detected: ${chain.join(" -> ")}`,
      expectDefined(chain[chain.length - 1], "chain entry at chain.length 1"),
    );
    this.name = "CircularIncludeError";
  }
}

// ============================================================================
// Utilities
// ============================================================================

/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
function deepMerge(target: unknown, source: unknown): unknown {
  return mergeDeepValues(target, source, { arrays: "concat", undefinedValues: "replace" });
}

// ============================================================================
// Include Resolver Class
// ============================================================================

class IncludeProcessor {
  private visited = new Set<string>();
  private depth = 0;

  constructor(
    private basePath: string,
    private resolver: IncludeResolver,
    private readonly boundary: IncludeBoundary,
  ) {
    this.visited.add(path.normalize(basePath));
  }

  private get rootDir(): string {
    return this.boundary.configRoot.rootDir;
  }

  process(obj: unknown, logicalPath: readonly string[] = []): unknown {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.process(item, logicalPath));
    }

    if (!isPlainObject(obj)) {
      return obj;
    }

    if (!(INCLUDE_KEY in obj)) {
      return this.processObject(obj, logicalPath);
    }

    return this.processInclude(obj, logicalPath);
  }

  private processObject(
    obj: Record<string, unknown>,
    logicalPath: readonly string[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.process(value, [...logicalPath, key]);
    }
    return result;
  }

  private processInclude(obj: Record<string, unknown>, logicalPath: readonly string[]): unknown {
    const includeValue = obj[INCLUDE_KEY];
    const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
    const included = this.resolveInclude(includeValue, logicalPath);
    this.resolver.onIncludeResolved?.({ path: [...logicalPath], value: included });

    if (otherKeys.length === 0) {
      return included;
    }

    if (!isPlainObject(included)) {
      throw new ConfigIncludeError(
        "Sibling keys require included content to be an object",
        typeof includeValue === "string" ? includeValue : INCLUDE_KEY,
      );
    }

    // Merge included content with sibling keys
    const rest: Record<string, unknown> = {};
    for (const key of otherKeys) {
      rest[key] = this.process(obj[key], [...logicalPath, key]);
    }
    return deepMerge(included, rest);
  }

  private resolveInclude(value: unknown, logicalPath: readonly string[]): unknown {
    if (typeof value === "string") {
      return this.loadFile(value, logicalPath);
    }

    if (Array.isArray(value)) {
      return value.reduce<unknown>((merged, item) => {
        if (typeof item !== "string") {
          throw new ConfigIncludeError(
            `Invalid $include array item: expected string, got ${typeof item}`,
            String(item),
          );
        }
        return deepMerge(merged, this.loadFile(item, logicalPath));
      }, {});
    }

    throw new ConfigIncludeError(
      `Invalid $include value: expected string or array of strings, got ${typeof value}`,
      String(value),
    );
  }

  private loadFile(includePath: string, logicalPath: readonly string[]): unknown {
    const { resolvedPath, root } = this.resolvePath(includePath);

    this.checkCircular(resolvedPath);
    this.checkDepth(includePath);

    const raw = this.readFile(includePath, resolvedPath, root);
    const parsed = this.parseFile(includePath, resolvedPath, raw);

    return this.processNested(resolvedPath, parsed, logicalPath);
  }

  private resolvePath(includePath: string): { resolvedPath: string; root: IncludeRoot } {
    if (includePath.includes("\0")) {
      throw new ConfigIncludeError("Include path must not contain null bytes", includePath);
    }
    if (includePath.length >= MAX_INCLUDE_PATH_LENGTH) {
      throw new ConfigIncludeError(
        `Include path exceeds maximum length (${MAX_INCLUDE_PATH_LENGTH} characters)`,
        includePath,
      );
    }

    const configDir = path.dirname(this.basePath);
    const resolved = path.isAbsolute(includePath)
      ? includePath
      : path.resolve(configDir, includePath);
    const normalized = path.normalize(resolved);

    if (normalized.length >= MAX_INCLUDE_PATH_LENGTH) {
      throw new ConfigIncludeError(
        `Resolved include path exceeds maximum length (${MAX_INCLUDE_PATH_LENGTH} characters)`,
        includePath,
      );
    }

    // SECURITY: Reject paths outside the config directory and any caller-allowed
    // roots (CWE-22: Path Traversal). Allowed roots come from
    // OPENCLAW_INCLUDE_ROOTS and let operators opt into shared include trees
    // without weakening the default lock-down.
    const lexicalMatch = this.findContainingRoot(normalized, "rootDir");
    if (!lexicalMatch) {
      throw new ConfigIncludeError(
        `Include path escapes config directory: ${includePath} (root: ${this.rootDir})`,
        includePath,
      );
    }
    this.resolver.onLexicalPath?.(normalized);

    // SECURITY: Resolve symlinks and re-validate to prevent symlink bypass.
    // The realpath may legitimately land in a different allowed root than the
    // lexical path (e.g. config dir contains a symlink into an allowed root),
    // so we recheck across all roots rather than pinning to the lexical match.
    try {
      const real = fs.realpathSync(normalized);
      const realMatch = this.findContainingRoot(real, "rootRealDir");
      if (!realMatch) {
        throw new ConfigIncludeError(
          `Include path resolves outside config directory (symlink): ${includePath} (root: ${this.rootDir})`,
          includePath,
        );
      }
      return { resolvedPath: normalized, root: realMatch };
    } catch (err) {
      if (err instanceof ConfigIncludeError) {
        throw err;
      }
      if (isNotFoundError(err)) {
        // File doesn't exist yet - lexical containment check above is sufficient.
        return { resolvedPath: normalized, root: lexicalMatch };
      }
      throw new ConfigIncludeError(
        `Failed to resolve include file realpath: ${includePath} (resolved: ${normalized})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private findContainingRoot(
    candidate: string,
    field: "rootDir" | "rootRealDir",
  ): IncludeRoot | null {
    if (isPathInside(this.boundary.configRoot[field], candidate)) {
      return this.boundary.configRoot;
    }
    for (const root of this.boundary.allowedRoots) {
      if (isPathInside(root[field], candidate)) {
        return root;
      }
    }
    return null;
  }

  private checkCircular(resolvedPath: string): void {
    if (this.visited.has(resolvedPath)) {
      throw new CircularIncludeError([...this.visited, resolvedPath]);
    }
  }

  private checkDepth(includePath: string): void {
    if (this.depth >= MAX_INCLUDE_DEPTH) {
      throw new ConfigIncludeError(
        `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`,
        includePath,
      );
    }
  }

  private readFile(includePath: string, resolvedPath: string, root: IncludeRoot): string {
    try {
      if (this.resolver.readFileWithGuards) {
        // This guard revalidates the opened file against root.rootRealDir, so
        // symlink swaps between resolvePath() and read are rejected at open time.
        return this.resolver.readFileWithGuards({
          includePath,
          resolvedPath,
          rootRealDir: root.rootRealDir,
        });
      }
      return this.resolver.readFile(resolvedPath);
    } catch (err) {
      if (err instanceof ConfigIncludeError) {
        throw err;
      }
      throw new ConfigIncludeError(
        `Failed to read include file: ${includePath} (resolved: ${resolvedPath})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private parseFile(includePath: string, resolvedPath: string, raw: string): unknown {
    try {
      return this.resolver.parseJson(raw);
    } catch (err) {
      throw new ConfigIncludeError(
        `Failed to parse include file: ${includePath} (resolved: ${resolvedPath})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private processNested(
    resolvedPath: string,
    parsed: unknown,
    logicalPath: readonly string[],
  ): unknown {
    const nested = new IncludeProcessor(resolvedPath, this.resolver, this.boundary);
    nested.visited = new Set([...this.visited, resolvedPath]);
    nested.depth = this.depth + 1;
    return nested.process(parsed, logicalPath);
  }
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** Capture the lexical and canonical include roots once for a resolver traversal. */
function createConfigIncludeBoundary(
  configPath: string,
  allowedRoots: ReadonlyArray<string> = [],
): IncludeBoundary {
  const configRootDir = path.normalize(path.dirname(configPath));
  return {
    configRoot: {
      rootDir: configRootDir,
      rootRealDir: path.normalize(safeRealpath(configRootDir)),
    },
    allowedRoots: allowedRoots
      .filter((entry) => typeof entry === "string" && entry.length > 0 && path.isAbsolute(entry))
      .map((entry) => {
        const rootDir = path.normalize(entry);
        return { rootDir, rootRealDir: path.normalize(safeRealpath(rootDir)) };
      }),
  };
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

export function readConfigIncludeFileWithGuards(params: IncludeFileReadParams): string {
  const ioFs = params.ioFs ?? fs;
  const maxBytes = params.maxBytes ?? MAX_INCLUDE_FILE_BYTES;
  if (!canUseRootFileOpen(ioFs)) {
    const raw = ioFs.readFileSync(params.resolvedPath, "utf-8");
    try {
      params.onResolvedPath?.(path.normalize(ioFs.realpathSync(params.resolvedPath)));
    } catch {
      // The guarded read succeeded; target tracking is best-effort on reduced fs shims.
    }
    return raw;
  }

  const opened = openRootFileSync({
    absolutePath: params.resolvedPath,
    rootPath: params.rootRealDir,
    rootRealPath: params.rootRealDir,
    boundaryLabel: "config directory",
    skipLexicalRootCheck: true,
    maxBytes,
    ioFs,
  });
  if (!opened.ok) {
    if (opened.reason === "validation") {
      throw new ConfigIncludeError(
        `Include file failed security checks (regular file, max ${maxBytes} bytes, no hardlinks): ${params.includePath}`,
        params.includePath,
      );
    }
    throw new ConfigIncludeError(
      `Failed to read include file: ${params.includePath} (resolved: ${params.resolvedPath})`,
      params.includePath,
      opened.error instanceof Error ? opened.error : undefined,
    );
  }

  try {
    const raw = ioFs.readFileSync(opened.fd, "utf-8");
    params.onResolvedPath?.(path.normalize(opened.path));
    return raw;
  } finally {
    ioFs.closeSync(opened.fd);
  }
}

// ============================================================================
// Public API
// ============================================================================

const defaultResolver: IncludeResolver = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
    readConfigIncludeFileWithGuards({ includePath, resolvedPath, rootRealDir }),
  parseJson: parseJsonWithJson5Fallback,
};

function resolveConfigIncludesWithinBoundary(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver,
  boundary: IncludeBoundary,
): unknown {
  return new IncludeProcessor(configPath, resolver, boundary).process(obj);
}

/**
 * Creates a resolver that shares one immutable root snapshot across independent
 * include resolutions. Used when callers must isolate malformed sibling graphs.
 */
export function createConfigIncludeResolutionSession(
  configPath: string,
  allowedRoots: ReadonlyArray<string> = [],
): (obj: unknown, basePath: string, resolver?: IncludeResolver) => unknown {
  const boundary = createConfigIncludeBoundary(configPath, allowedRoots);
  return (obj, basePath, resolver = defaultResolver) =>
    resolveConfigIncludesWithinBoundary(obj, basePath, resolver, boundary);
}

/**
 * Resolves all $include directives in a parsed config object.
 */
export function resolveConfigIncludes(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver = defaultResolver,
  options: ResolveConfigIncludesOptions = {},
): unknown {
  const boundary = createConfigIncludeBoundary(configPath, options.allowedRoots ?? []);
  return resolveConfigIncludesWithinBoundary(obj, configPath, resolver, boundary);
}
