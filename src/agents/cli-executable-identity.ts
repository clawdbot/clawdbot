import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgramCandidate,
} from "../plugin-sdk/windows-spawn.js";
import type { CliBackendRuntimeArtifactPolicy } from "../plugins/cli-backend.types.js";

type CliExecutableFileIdentity = Readonly<{
  path: string;
  device: string;
  inode: string;
  mode: string;
  size: string;
  modifiedNs: string;
  changedNs: string;
  contentSha256: string;
}>;

/** Immutable executable projection bound to one successful CLI process. */
export type CliExecutableIdentity = Readonly<{
  command: string;
  resolvedPath: string;
  invocation: Readonly<{
    command: string;
    leadingArgv: readonly string[];
    resolution: "direct" | "node-entrypoint" | "exe-entrypoint";
  }>;
  files: readonly CliExecutableFileIdentity[];
  runtimeArtifact:
    | Readonly<{ kind: "self-contained-executable" }>
    | Readonly<{
        kind: "package-tree";
        packageName: string;
        rootPath: string;
        fileCount: number;
        totalBytes: string;
        treeSha256: string;
      }>;
}>;

type ReadIdentityResult = {
  identity: CliExecutableFileIdentity;
  prefix: Buffer;
};

const MAX_PACKAGE_ARTIFACT_FILES = 8192;
const MAX_PACKAGE_ARTIFACT_ENTRIES = MAX_PACKAGE_ARTIFACT_FILES * 4;
const MAX_PACKAGE_ARTIFACT_BYTES = 1024n * 1024n * 1024n;
type StableBigIntFileStat = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function sameOpenedFile(left: StableBigIntFileStat, right: StableBigIntFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function compareArtifactEntryNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readExecutableFileIdentity(filePath: string): Promise<ReadIdentityResult | null> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(filePath);
  } catch {
    return null;
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(canonicalPath, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return null;
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const prefixChunks: Buffer[] = [];
    let prefixBytes = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (prefixBytes < 4096) {
        const prefixChunk = Buffer.from(chunk.subarray(0, 4096 - prefixBytes));
        prefixChunks.push(prefixChunk);
        prefixBytes += prefixChunk.length;
      }
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.stat(canonicalPath, { bigint: true });
    if (!sameOpenedFile(before, after) || !sameOpenedFile(after, current)) {
      return null;
    }
    return {
      identity: {
        path: canonicalPath,
        device: String(after.dev),
        inode: String(after.ino),
        mode: String(after.mode),
        size: String(after.size),
        modifiedNs: String(after.mtimeNs),
        changedNs: String(after.ctimeNs),
        contentSha256: hash.digest("hex"),
      },
      prefix: Buffer.concat(prefixChunks, prefixBytes),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isDurableRootedCommand(value: string): boolean {
  return path.isAbsolute(value) || /^~[\\/]/u.test(value);
}

function pathEntriesAreAbsolute(env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .every((entry) => path.isAbsolute(entry));
}

function resolveCommandPath(params: {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  if (!hasPathSeparator(params.command) && !pathEntriesAreAbsolute(params.env)) {
    // A relative PATH entry resolves against the child cwd. That cwd is not a
    // durable route fact, so it cannot safely back a persistent owner proof.
    return undefined;
  }
  if (hasPathSeparator(params.command) && !isDurableRootedCommand(params.command)) {
    // The setup probe and later OpenClaw turns intentionally use different
    // workspaces. A cwd-relative executable cannot name one durable owner.
    return undefined;
  }
  return resolveExecutablePath(params.command, {
    ...(params.cwd ? { cwd: params.cwd } : {}),
    env: params.env,
  });
}

function hasShebang(prefix: Buffer): boolean {
  return prefix.subarray(0, 2).toString("utf8") === "#!";
}

function parseShebangInterpreter(
  prefix: Buffer,
): { executable: string; args: string[]; viaEnv?: string } | null {
  const firstLine = prefix.toString("utf8").split(/\r?\n/u, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) {
    return null;
  }
  const tokens = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
  const executable = tokens[0];
  if (!executable) {
    return null;
  }
  if (path.basename(executable) !== "env") {
    return { executable, args: tokens.slice(1) };
  }
  const envArgs = tokens.slice(1);
  const commandStart = envArgs[0] === "-S" ? 1 : 0;
  const viaEnv = envArgs[commandStart];
  if (!viaEnv || viaEnv.startsWith("-")) {
    return null;
  }
  return { executable, viaEnv, args: envArgs.slice(commandStart + 1) };
}

async function findOwnedPackageRoot(params: {
  entrypointPath: string;
  policy: CliBackendRuntimeArtifactPolicy;
}): Promise<string | undefined> {
  let directory = path.dirname(params.entrypointPath);
  for (;;) {
    const packageJsonPath = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { name?: unknown };
      if (parsed.name === params.policy.packageName) {
        return await fs.realpath(directory);
      }
    } catch {
      // Continue through parent package scopes.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

async function resolvePackageTreeArtifact(params: {
  entrypointPath: string;
  policy: CliBackendRuntimeArtifactPolicy | undefined;
}): Promise<CliExecutableIdentity["runtimeArtifact"] | undefined> {
  if (!params.policy || params.policy.kind !== "bundled-package-tree") {
    return undefined;
  }
  const rootPath = await findOwnedPackageRoot({
    entrypointPath: params.entrypointPath,
    policy: params.policy,
  });
  if (!rootPath) {
    return undefined;
  }
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(rootPath, "package.json"), "utf8"),
    ) as {
      dependencies?: unknown;
      peerDependencies?: unknown;
    };
    const externalDependencyDeclarations = [packageJson.dependencies, packageJson.peerDependencies];
    if (
      externalDependencyDeclarations.some(
        (dependencies) =>
          dependencies !== undefined &&
          (dependencies === null ||
            typeof dependencies !== "object" ||
            Array.isArray(dependencies) ||
            Object.keys(dependencies).length > 0),
      )
    ) {
      // The package-tree contract is intentionally self-contained. Required
      // dependencies or peers may be hoisted outside this root and escape hashing.
      return undefined;
    }
  } catch {
    return undefined;
  }
  const hash = crypto.createHash("sha256");
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0n;
  const visit = async (directory: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return false;
    }
    // Locale collation can differ across hosts. Artifact bytes must have one
    // process- and locale-independent traversal order.
    for (const entry of entries.toSorted((left, right) =>
      compareArtifactEntryNames(left.name, right.name),
    )) {
      entryCount += 1;
      if (entryCount > MAX_PACKAGE_ARTIFACT_ENTRIES) {
        return false;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!(await visit(entryPath))) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        // Symlinks and special files can redirect outside the declared package.
        return false;
      }
      let size: bigint;
      try {
        const stat = await fs.stat(entryPath, { bigint: true });
        if (!stat.isFile()) {
          return false;
        }
        size = stat.size;
      } catch {
        return false;
      }
      if (
        fileCount + 1 > MAX_PACKAGE_ARTIFACT_FILES ||
        totalBytes + size > MAX_PACKAGE_ARTIFACT_BYTES
      ) {
        return false;
      }
      const file = await readExecutableFileIdentity(entryPath);
      if (!file) {
        return false;
      }
      fileCount += 1;
      totalBytes += BigInt(file.identity.size);
      if (fileCount > MAX_PACKAGE_ARTIFACT_FILES || totalBytes > MAX_PACKAGE_ARTIFACT_BYTES) {
        return false;
      }
      hash.update(
        JSON.stringify([
          path.relative(rootPath, file.identity.path).split(path.sep).join("/"),
          file.identity.mode,
          file.identity.size,
          file.identity.contentSha256,
        ]),
      );
      hash.update("\n");
    }
    return true;
  };
  if (!(await visit(rootPath)) || fileCount === 0) {
    return undefined;
  }
  return {
    kind: "package-tree",
    packageName: params.policy.packageName,
    rootPath,
    fileCount,
    totalBytes: String(totalBytes),
    treeSha256: hash.digest("hex"),
  };
}

function allowsSelfContainedExecutable(
  filePath: string,
  resolvedCommandPath: string,
  policy: CliBackendRuntimeArtifactPolicy | undefined,
): boolean {
  if (!policy) {
    return false;
  }
  const basenames = new Set(
    [filePath, resolvedCommandPath].map((candidate) => {
      const basename = path.basename(candidate);
      return process.platform === "win32" ? basename.toLowerCase() : basename;
    }),
  );
  return (
    policy.nativeExecutableNames?.some((name) =>
      basenames.has(process.platform === "win32" ? name.toLowerCase() : name),
    ) === true
  );
}

async function resolvePosixIdentity(params: {
  command: string;
  resolvedPath: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  runtimeArtifact?: CliBackendRuntimeArtifactPolicy;
}): Promise<CliExecutableIdentity | undefined> {
  const commandFile = await readExecutableFileIdentity(params.resolvedPath);
  if (!commandFile) {
    return undefined;
  }
  const files = [commandFile.identity];
  const commandHasShebang = hasShebang(commandFile.prefix);
  const shebang = parseShebangInterpreter(commandFile.prefix);
  if (commandHasShebang && !shebang) {
    return undefined;
  }
  if (shebang && shebang.args.length > 0) {
    // Interpreter flags can load code outside the declared package tree.
    return undefined;
  }
  const packageEntrypoint = shebang ? commandFile.identity : undefined;
  const runtimeArtifact = packageEntrypoint
    ? await resolvePackageTreeArtifact({
        entrypointPath: packageEntrypoint.path,
        policy: params.runtimeArtifact,
      })
    : allowsSelfContainedExecutable(
          commandFile.identity.path,
          params.resolvedPath,
          params.runtimeArtifact,
        )
      ? ({ kind: "self-contained-executable" } as const)
      : undefined;
  if (!runtimeArtifact) {
    return undefined;
  }
  if (shebang) {
    const interpreterPath = resolveCommandPath({
      command: shebang.executable,
      cwd: params.cwd,
      env: params.env,
    });
    if (!interpreterPath) {
      return undefined;
    }
    const interpreter = await readExecutableFileIdentity(interpreterPath);
    if (!interpreter || hasShebang(interpreter.prefix)) {
      return undefined;
    }
    files.push(interpreter.identity);
    let invocationInterpreter = interpreter.identity.path;
    if (shebang.viaEnv) {
      const targetPath = resolveCommandPath({
        command: shebang.viaEnv,
        cwd: params.cwd,
        env: params.env,
      });
      if (!targetPath) {
        return undefined;
      }
      const target = await readExecutableFileIdentity(targetPath);
      if (!target || hasShebang(target.prefix)) {
        return undefined;
      }
      files.push(target.identity);
      invocationInterpreter = target.identity.path;
    }
    return {
      command: params.command,
      resolvedPath: commandFile.identity.path,
      invocation: {
        command: invocationInterpreter,
        leadingArgv: [...shebang.args, commandFile.identity.path],
        resolution: "direct",
      },
      files: dedupeFileIdentities(files),
      runtimeArtifact,
    };
  }
  const resolvedPath = commandFile.identity.path;
  return {
    command: params.command,
    resolvedPath,
    invocation: {
      // Spawn the exact file opened and hashed, not a mutable symlink alias.
      command: resolvedPath,
      leadingArgv: [],
      resolution: "direct",
    },
    files: dedupeFileIdentities(files),
    runtimeArtifact,
  };
}

function dedupeFileIdentities(
  files: readonly CliExecutableFileIdentity[],
): CliExecutableFileIdentity[] {
  return files.filter(
    (file, index) => files.findIndex((candidate) => candidate.path === file.path) === index,
  );
}

async function resolveWindowsIdentity(params: {
  command: string;
  resolvedPath: string;
  env: NodeJS.ProcessEnv;
  runtimeArtifact?: CliBackendRuntimeArtifactPolicy;
}): Promise<CliExecutableIdentity | undefined> {
  const nodePath = resolveWindowsExecutablePath("node", params.env);
  const candidate = resolveWindowsSpawnProgramCandidate({
    command: params.resolvedPath,
    env: params.env,
    execPath: nodePath,
  });
  if (candidate.resolution === "unresolved-wrapper") {
    return undefined;
  }
  if (
    candidate.resolution === "node-entrypoint" &&
    path.extname(candidate.command).toLowerCase() !== ".exe"
  ) {
    return undefined;
  }
  const configuredFile = await readExecutableFileIdentity(params.resolvedPath);
  const invocationFile = await readExecutableFileIdentity(candidate.command);
  if (!configuredFile || !invocationFile) {
    return undefined;
  }
  const files = [configuredFile.identity, invocationFile.identity];
  const leadingArgv: string[] = [];
  for (const entry of candidate.leadingArgv) {
    const entryFile = await readExecutableFileIdentity(entry);
    if (!entryFile) {
      return undefined;
    }
    files.push(entryFile.identity);
    leadingArgv.push(entryFile.identity.path);
  }
  const commandEntrypoint =
    candidate.resolution === "node-entrypoint"
      ? files.find((file) => file.path === leadingArgv[0])
      : undefined;
  if (candidate.resolution === "direct" && hasShebang(invocationFile.prefix)) {
    return undefined;
  }
  const scriptEntrypoint = commandEntrypoint;
  const runtimeArtifact = scriptEntrypoint
    ? await resolvePackageTreeArtifact({
        entrypointPath: scriptEntrypoint.path,
        policy: params.runtimeArtifact,
      })
    : allowsSelfContainedExecutable(
          invocationFile.identity.path,
          params.resolvedPath,
          params.runtimeArtifact,
        )
      ? ({ kind: "self-contained-executable" } as const)
      : undefined;
  if (!runtimeArtifact) {
    return undefined;
  }
  return {
    command: params.command,
    resolvedPath: configuredFile.identity.path,
    invocation: {
      command: invocationFile.identity.path,
      leadingArgv,
      resolution: candidate.resolution,
    },
    files: dedupeFileIdentities(files),
    runtimeArtifact,
  };
}

/**
 * Resolve and fingerprint the exact program a CLI child will execute.
 *
 * Call only while minting or revalidating verified setup authority: content
 * hashing is deliberate and must not enter the normal CLI request hot path.
 */
export async function resolveCliExecutableIdentity(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runtimeArtifact?: CliBackendRuntimeArtifactPolicy;
}): Promise<CliExecutableIdentity | undefined> {
  const command = params.command.trim();
  if (!command) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const resolvedPath = resolveCommandPath({
    command,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    env,
  });
  if (!resolvedPath) {
    return undefined;
  }
  return process.platform === "win32"
    ? await resolveWindowsIdentity({
        command,
        resolvedPath,
        env,
        ...(params.runtimeArtifact ? { runtimeArtifact: params.runtimeArtifact } : {}),
      })
    : await resolvePosixIdentity({
        command,
        resolvedPath,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        env,
        ...(params.runtimeArtifact ? { runtimeArtifact: params.runtimeArtifact } : {}),
      });
}
