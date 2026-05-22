import { posix as pathPosix } from "node:path";
import type { JsonObject } from "../protocol.js";
import { requireObject, requireString } from "./json-rpc.js";
import type {
  FsAccessMode,
  OpenClawExecServer,
  ResolvedFsSandboxEntry,
  ResolvedFsSandboxPolicy,
} from "./types.js";

export function assertFsSandboxAccess(
  execServer: OpenClawExecServer,
  record: JsonObject,
  requests: Array<{ path: string; access: "read" | "write" }>,
): void {
  assertResolvedFsSandboxAccess(resolveFsSandboxPolicy(execServer, record), requests);
}

export function resolveFsSandboxPolicy(
  execServer: OpenClawExecServer,
  record: JsonObject,
): ResolvedFsSandboxPolicy | undefined {
  if (record.sandbox === undefined || record.sandbox === null) {
    return undefined;
  }
  const sandbox = requireObject(record.sandbox, "fs sandbox context");
  const permissions = requireObject(sandbox.permissions, "fs sandbox permissions");
  const permissionType = requireString(permissions.type, "fs sandbox permissions type");
  if (permissionType === "disabled" || permissionType === "external") {
    return { unrestricted: true, entries: [] };
  }
  if (permissionType !== "managed") {
    throw new Error(`Unsupported Codex fs sandbox permission type: ${permissionType}`);
  }

  const fileSystem = requireObject(permissions.file_system, "fs sandbox file system permissions");
  const fileSystemType = requireString(fileSystem.type, "fs sandbox file system permissions type");
  if (fileSystemType === "unrestricted") {
    return { unrestricted: true, entries: [] };
  }
  if (fileSystemType !== "restricted") {
    throw new Error(`Unsupported Codex fs sandbox file system type: ${fileSystemType}`);
  }
  if (!Array.isArray(fileSystem.entries)) {
    throw new Error("fs sandbox file system entries must be an array.");
  }
  const cwd = readFsSandboxCwd(execServer, sandbox);
  return {
    unrestricted: false,
    entries: fileSystem.entries.flatMap((entry, index) => {
      const resolved = resolveFsSandboxEntry(
        requireObject(entry, `fs sandbox entry ${index}`),
        cwd,
      );
      return resolved ? [resolved] : [];
    }),
  };
}

function readFsSandboxCwd(execServer: OpenClawExecServer, sandbox: JsonObject): string {
  if (sandbox.cwd === undefined || sandbox.cwd === null) {
    return normalizeSandboxAbsolutePath(execServer.sandbox.containerWorkdir, "sandbox cwd");
  }
  return normalizeSandboxAbsolutePath(requireString(sandbox.cwd, "sandbox cwd"), "sandbox cwd");
}

function resolveFsSandboxEntry(entry: JsonObject, cwd: string): ResolvedFsSandboxEntry | undefined {
  const access = readFsAccessMode(entry.access);
  const pathSpec = requireObject(entry.path, "fs sandbox entry path");
  const pathType = requireString(pathSpec.type, "fs sandbox entry path type");
  if (pathType === "path") {
    return {
      kind: "path",
      path: normalizeSandboxAbsolutePath(
        requireString(pathSpec.path, "fs sandbox path"),
        "fs sandbox path",
      ),
      access,
    };
  }
  if (pathType === "special") {
    if (isNonGrantingFsSpecialPath(requireObject(pathSpec.value, "fs sandbox special path"))) {
      return undefined;
    }
    return {
      kind: "path",
      path: resolveFsSpecialPath(requireObject(pathSpec.value, "fs sandbox special path"), cwd),
      access,
    };
  }
  if (pathType === "glob_pattern") {
    const pattern = requireString(pathSpec.pattern, "fs sandbox glob pattern");
    const absolutePattern = normalizeSandboxGlobPattern(
      pattern.startsWith("/") ? pattern : pathPosix.join(cwd, pattern),
    );
    return {
      kind: "glob",
      pattern: absolutePattern,
      matcher: compileSandboxGlobPattern(absolutePattern),
      literalPrefix: sandboxGlobLiteralPrefix(absolutePattern),
      access,
    };
  }
  throw new Error(`Unsupported Codex fs sandbox path type: ${pathType}`);
}

function isNonGrantingFsSpecialPath(value: JsonObject): boolean {
  const kind = requireString(value.kind, "fs sandbox special path kind");
  return kind === "minimal" || kind === "unknown";
}

function readFsAccessMode(value: unknown): FsAccessMode {
  if (value === "read" || value === "write" || value === "none") {
    return value;
  }
  if (value === "deny") {
    return "none";
  }
  throw new Error("fs sandbox entry access must be read, write, none, or deny.");
}

function resolveFsSpecialPath(value: JsonObject, cwd: string): string {
  const kind = requireString(value.kind, "fs sandbox special path kind");
  if (kind === "root") {
    return "/";
  }
  if (kind === "project_roots" || kind === "current_working_directory") {
    const subpath =
      value.subpath === undefined || value.subpath === null
        ? undefined
        : requireString(value.subpath, "fs sandbox project roots subpath");
    return normalizeSandboxAbsolutePath(
      subpath ? pathPosix.join(cwd, subpath) : cwd,
      "fs sandbox project roots path",
    );
  }
  if (kind === "slash_tmp" || kind === "tmpdir") {
    return "/tmp";
  }
  throw new Error(`Unsupported Codex fs sandbox special path: ${kind}`);
}

export function assertResolvedFsSandboxAccess(
  policy: ResolvedFsSandboxPolicy | undefined,
  requests: Array<{ path: string; access: "read" | "write" }>,
): void {
  if (!policy?.unrestricted && policy) {
    for (const request of requests) {
      const access = resolveFsAccess(policy, request.path);
      if (request.access === "read" && access === "none") {
        throw new Error(`Codex fs sandbox denied read access to ${request.path}`);
      }
      if (request.access === "write" && access !== "write") {
        throw new Error(`Codex fs sandbox denied write access to ${request.path}`);
      }
    }
  }
}

function resolveFsAccess(policy: ResolvedFsSandboxPolicy, rawPath: string): FsAccessMode {
  if (policy.unrestricted) {
    return "write";
  }
  const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
  let selected: { specificity: number; rank: number; access: FsAccessMode } | undefined;
  for (const entry of policy.entries) {
    if (!fsSandboxEntryMatches(entry, target)) {
      continue;
    }
    const candidate = {
      specificity: fsSandboxEntrySpecificity(entry),
      rank: fsAccessRank(entry.access),
      access: entry.access,
    };
    if (
      !selected ||
      candidate.specificity > selected.specificity ||
      (candidate.specificity === selected.specificity && candidate.rank > selected.rank)
    ) {
      selected = candidate;
    }
  }
  return selected?.access ?? "none";
}

export function assertNoReadOnlyDescendant(
  policy: ResolvedFsSandboxPolicy | undefined,
  rawPath: string,
  operation: string,
): void {
  if (!policy || policy.unrestricted) {
    return;
  }
  const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
  const protectedDescendant = policy.entries.find((entry) => {
    if (entry.access === "write" || !fsSandboxEntryCanAffectDescendant(entry, target)) {
      return false;
    }
    if (entry.kind === "glob") {
      return true;
    }
    const protectedPath = entry.path;
    return protectedPath && resolveFsAccess(policy, protectedPath) !== "write";
  });
  if (protectedDescendant) {
    const protectedPath =
      protectedDescendant.kind === "path" ? protectedDescendant.path : protectedDescendant.pattern;
    throw new Error(
      `Codex fs sandbox denied recursive ${operation} of ${rawPath} because ${protectedPath} is not writable.`,
    );
  }
}

export function normalizeSandboxAbsolutePath(rawPath: string, label: string): string {
  if (!rawPath || rawPath.includes("\0") || !rawPath.startsWith("/")) {
    throw new Error(`${label} must be an absolute sandbox path.`);
  }
  const normalized = pathPosix.normalize(rawPath);
  return normalized === "//" ? "/" : normalized;
}

export function pathContains(root: string, target: string): boolean {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function fsSandboxEntryMatches(entry: ResolvedFsSandboxEntry, target: string): boolean {
  if (entry.kind === "path") {
    return pathContains(entry.path, target);
  }
  return entry.matcher.test(target);
}

function fsSandboxEntryCanAffectDescendant(entry: ResolvedFsSandboxEntry, target: string): boolean {
  if (entry.kind === "path") {
    return pathContains(target, entry.path) && target !== entry.path;
  }
  return pathContains(target, entry.literalPrefix) || pathContains(entry.literalPrefix, target);
}

function fsSandboxEntrySpecificity(entry: ResolvedFsSandboxEntry): number {
  return pathSpecificity(entry.kind === "path" ? entry.path : entry.literalPrefix);
}

function pathSpecificity(filePath: string): number {
  return filePath === "/" ? 0 : filePath.split("/").filter(Boolean).length;
}

function fsAccessRank(access: FsAccessMode): number {
  if (access === "none") {
    return 2;
  }
  if (access === "write") {
    return 1;
  }
  return 0;
}

function normalizeSandboxGlobPattern(pattern: string): string {
  if (!pattern || pattern.includes("\0") || !pattern.startsWith("/")) {
    throw new Error("fs sandbox glob pattern must be absolute.");
  }
  return pattern.replace(/\/{2,}/gu, "/");
}

function compileSandboxGlobPattern(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const compiledClass = compileSandboxGlobCharacterClass(pattern, index);
      source += compiledClass.source;
      index = compiledClass.endIndex;
    } else {
      source += char?.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&") ?? "";
    }
  }
  source += "$";
  return new RegExp(source, "u");
}

function compileSandboxGlobCharacterClass(
  pattern: string,
  startIndex: number,
): { source: string; endIndex: number } {
  let index = startIndex + 1;
  if (index >= pattern.length) {
    throw new Error("fs sandbox glob character class must be closed.");
  }
  const negated = pattern[index] === "!" || pattern[index] === "^";
  if (negated) {
    index += 1;
  }
  let body = "";
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]" && body) {
      return {
        source: `[${negated ? "^" : ""}${body}]`,
        endIndex: index,
      };
    }
    if (!char || char === "/") {
      throw new Error("fs sandbox glob character class cannot match path separators.");
    }
    body += escapeSandboxGlobCharacterClassChar(char, body.length === 0);
  }
  throw new Error("fs sandbox glob character class must be closed.");
}

function escapeSandboxGlobCharacterClassChar(char: string, first: boolean): string {
  if (char === "\\" || char === "]") {
    return `\\${char}`;
  }
  if (first && char === "^") {
    return "\\^";
  }
  return char;
}

function sandboxGlobLiteralPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[*?[]/u);
  const prefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  const slash = prefix.lastIndexOf("/");
  if (slash <= 0) {
    return "/";
  }
  return normalizeSandboxAbsolutePath(prefix.slice(0, slash), "fs sandbox glob prefix");
}

export function joinSandboxChildPath(parent: string, child: string): string {
  if (!child || child === "." || child === ".." || child.includes("/") || child.includes("\0")) {
    throw new Error(`Invalid sandbox directory entry name: ${child}`);
  }
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}
