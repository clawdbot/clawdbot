import path from "node:path";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxCapabilityRootDiscovery,
  SandboxCapabilityRootRequest,
} from "openclaw/plugin-sdk/sandbox";
import { z } from "zod";
import { isOpenShellRemotePathInside } from "./workspace-roots.js";

const MAX_ROOTS = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ROOT_BYTES = 1024 * 1024;
const MAX_SKILLS = 64;
const MAX_PATH_CHARS = 4096;

// The executor owns IO only. Pin every directory and leaf with no-follow opens,
// and bound reads before allocation (including files which grow after fstat).
const DISCOVER_CAPABILITIES_SCRIPT = String.raw`
set -eu
python_bin=$(command -v python3 || command -v python)
"$python_bin" -c '
import json, os, stat, sys

root = sys.argv[1]
excluded = json.loads(sys.argv[2])
result = {"skills": [], "warnings": []}
remaining = ${MAX_ROOT_BYTES}
entries_left = 2048
files_left = 1 + ${MAX_SKILLS} * 2
dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def warn(message):
    if message not in result["warnings"] and len(result["warnings"]) < 16:
        result["warnings"].append(message)

def open_dir(parent, name):
    return os.open(name, dir_flags, dir_fd=parent)

def read_text(parent, name, location):
    global remaining, files_left
    if files_left <= 0:
        warn("capability file count limit reached")
        return None
    files_left -= 1
    fd = None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            warn("non-regular or hardlinked capability file skipped")
            return None
        limit = min(${MAX_FILE_BYTES}, remaining)
        if info.st_size > limit:
            warn("capability file or root byte limit exceeded")
            return None
        with os.fdopen(fd, "rb") as stream:
            fd = None
            data = stream.read(limit + 1)
        if len(data) > limit:
            warn("capability file or root byte limit exceeded")
            return None
        remaining -= len(data)
        return {"path": location, "contents": data.decode("utf-8", errors="strict")}
    except FileNotFoundError:
        return None
    except UnicodeError:
        warn("non-UTF-8 capability file skipped")
    except OSError:
        warn("unreadable or symlinked capability file skipped")
    finally:
        if fd is not None:
            os.close(fd)
    return None

def scan(fd, location, depth):
    global entries_left
    names = []
    try:
        with os.scandir(fd) as iterator:
            for item in iterator:
                if entries_left <= 0:
                    warn("capability traversal entry limit reached")
                    return
                entries_left -= 1
                names.append(item.name)
    except OSError:
        warn("capability directory scan failed")
        return
    for name in sorted(names):
        child = os.path.join(location, name)
        if len(child) > ${MAX_PATH_CHARS}:
            warn("capability path length limit exceeded")
            continue
        if any(child == p or child.startswith(p + "/") for p in excluded):
            continue
        if name in (".git", "node_modules") or child == os.path.join(root, ".openclaw/sandbox-skills"):
            continue
        if name == "SKILL.md":
            if len(result["skills"]) >= ${MAX_SKILLS}:
                warn("capability skill count limit reached")
                continue
            instructions = read_text(fd, name, child)
            if instructions is not None:
                skill = {"instructions": instructions}
                try:
                    metadata_fd = open_dir(fd, "agents")
                    try:
                        metadata = read_text(metadata_fd, "openai.yaml", location + "/agents/openai.yaml")
                        if metadata is not None:
                            skill["metadata"] = metadata
                    finally:
                        os.close(metadata_fd)
                except FileNotFoundError:
                    pass
                except OSError:
                    warn("unreadable or symlinked skill metadata directory skipped")
                result["skills"].append(skill)
            continue
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                warn("symlinked capability path skipped")
                continue
            if not stat.S_ISDIR(info.st_mode):
                continue
            if depth >= 6:
                warn("capability traversal depth limit reached")
                continue
            child_fd = open_dir(fd, name)
            try:
                scan(child_fd, child, depth + 1)
            finally:
                os.close(child_fd)
        except OSError:
            warn("capability directory scan failed")

fd = os.open("/", dir_flags)
try:
    for part in root.split("/"):
        if part:
            child_fd = open_dir(fd, part)
            os.close(fd)
            fd = child_fd
    config_path = os.path.join(root, ".mcp.json")
    if not any(config_path == p or config_path.startswith(p + "/") for p in excluded):
        config = read_text(fd, ".mcp.json", config_path)
        if config is not None:
            result["mcpConfig"] = config
    scan(fd, root, 0)
except OSError:
    result["error"] = "capability root is unavailable or symlinked"
finally:
    os.close(fd)
print(json.dumps(result, ensure_ascii=True))
' "$1" "$2"
`;

const textFileSchema = z.object({
  path: z.string().max(MAX_PATH_CHARS),
  contents: z.string().refine((value) => Buffer.byteLength(value) <= MAX_FILE_BYTES),
});
const discoverySchema = z.object({
  mcpConfig: textFileSchema.optional(),
  skills: z
    .array(z.object({ instructions: textFileSchema, metadata: textFileSchema.optional() }))
    .max(MAX_SKILLS),
  warnings: z.array(z.string().max(256)).max(16),
  error: z.string().max(256).optional(),
});

function isContained(root: string, file: string): boolean {
  return (
    path.posix.isAbsolute(file) &&
    path.posix.normalize(file) === file &&
    isOpenShellRemotePathInside(root, file)
  );
}

export async function discoverOpenShellCapabilityRoots(params: {
  roots: readonly SandboxCapabilityRootRequest[];
  signal?: AbortSignal;
  runCommand: (params: SandboxBackendCommandParams) => Promise<SandboxBackendCommandResult>;
}): Promise<SandboxCapabilityRootDiscovery[]> {
  if (params.roots.length > MAX_ROOTS) {
    throw new Error(`Capability discovery accepts at most ${MAX_ROOTS} roots.`);
  }
  const results: SandboxCapabilityRootDiscovery[] = [];
  for (const root of params.roots) {
    params.signal?.throwIfAborted();
    const excluded = root.excludePaths ?? [];
    if (
      root.path.length > MAX_PATH_CHARS ||
      !path.posix.isAbsolute(root.path) ||
      path.posix.normalize(root.path) !== root.path ||
      excluded.length > 128 ||
      excluded.some((value) => value.length > MAX_PATH_CHARS || !isContained(root.path, value))
    ) {
      results.push({
        id: root.id,
        path: root.path,
        error: "invalid capability root or exclusions",
      });
      continue;
    }
    try {
      const result = await params.runCommand({
        script: DISCOVER_CAPABILITIES_SCRIPT,
        args: [root.path, JSON.stringify(excluded)],
        signal: params.signal,
        allowFailure: true,
      });
      params.signal?.throwIfAborted();
      if (result.code !== 0) {
        // Remote stderr can contain secrets; diagnostics describe the operation, not its payload.
        throw new Error("capability discovery command failed");
      }
      if (result.stdout.length > MAX_ROOT_BYTES * 6 + 128 * 1024) {
        throw new Error("capability discovery response exceeds byte limit");
      }
      const discovery = discoverySchema.parse(JSON.parse(result.stdout.toString("utf8")));
      const files = [
        discovery.mcpConfig,
        ...discovery.skills.flatMap((skill) => [skill.instructions, skill.metadata]),
      ].filter((file) => file !== undefined);
      if (
        files.reduce((total, file) => total + Buffer.byteLength(file.contents), 0) >
          MAX_ROOT_BYTES ||
        files.some(
          (file) =>
            !isContained(root.path, file.path) || excluded.some((p) => isContained(p, file.path)),
        )
      ) {
        throw new Error("invalid capability file boundary");
      }
      results.push({ id: root.id, path: root.path, ...discovery });
    } catch {
      params.signal?.throwIfAborted();
      results.push({
        id: root.id,
        path: root.path,
        error: "capability discovery failed or returned invalid data",
      });
    }
  }
  return results;
}
