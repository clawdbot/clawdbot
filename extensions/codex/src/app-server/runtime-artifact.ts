/** Exact local runtime artifact identity for verified Codex setup turns. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerClient, CodexAppServerRuntimeIdentity } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const ARTIFACT_ID_PREFIX = "codex-app-server:v1:";
const ARTIFACT_HASH_DOMAIN = "openclaw-codex-app-server-runtime-artifact-v1\0";
const MAX_ARTIFACT_ID_BYTES = 32 * 1024;
const MAX_ARTIFACT_PATH_BYTES = 4096;
const MAX_ARTIFACT_INVOCATION_PATHS = 8;
const MAX_ARTIFACT_DEPTH = 64;
const MAX_ARTIFACT_ENTRIES = 32_768;
const MAX_ARTIFACT_FILES = 8192;
const MAX_ARTIFACT_TOTAL_BYTES = 1024n * 1024n * 1024n;
const READ_CHUNK_BYTES = 64 * 1024;
const CODE_MODE_HOST_PATH_ENV = "CODEX_CODE_MODE_HOST_PATH";
const RUNTIME_INJECTION_ENV_KEYS = new Set([
  "NODE_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);
const ARTIFACT_BINDINGS_SYMBOL = Symbol.for("openclaw.codexAppServerRuntimeArtifactBindings");

type CodexRuntimeArtifactSpawnIdentity = Readonly<{
  command: string;
  argsFingerprint: string;
  commandSource?: CodexAppServerStartOptions["commandSource"];
  managedCommandOrder?: CodexAppServerStartOptions["managedCommandOrder"];
  nativeCommand?: string;
}>;

type CodexRuntimeFilesystemDescriptor = Readonly<{
  version: 1;
  commandPath: string;
  commandRealPath: string;
  invocationPaths: readonly string[];
  nativePath: string;
  packageRoot?: string;
  codeModeHostCandidatePath: string;
  codeModeHostPath?: string;
  argsFingerprint: string;
  commandSource?: CodexAppServerStartOptions["commandSource"];
  managedCommandOrder?: CodexAppServerStartOptions["managedCommandOrder"];
}>;

type CodexRuntimeArtifactDescriptor = CodexRuntimeFilesystemDescriptor &
  Readonly<{
    serverVersion: string;
    userAgentFingerprint?: string;
  }>;

export type CodexAppServerRuntimeArtifactCapture = Readonly<{
  descriptor: CodexRuntimeFilesystemDescriptor;
  contentFingerprint: string;
}>;

type StableBigIntFileStat = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type ArtifactHashBudget = {
  fileCount: number;
  totalBytes: bigint;
};

function getRuntimeArtifactBindings(): WeakMap<
  CodexAppServerClient,
  AgentHarnessRuntimeArtifactBinding
> {
  const globalState = globalThis as typeof globalThis & {
    [ARTIFACT_BINDINGS_SYMBOL]?: WeakMap<CodexAppServerClient, AgentHarnessRuntimeArtifactBinding>;
  };
  globalState[ARTIFACT_BINDINGS_SYMBOL] ??= new WeakMap();
  return globalState[ARTIFACT_BINDINGS_SYMBOL];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex runtime artifact capture aborted");
}

function compareArtifactNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

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

async function readRegularFileFingerprint(params: {
  filePath: string;
  budget: ArtifactHashBudget;
  signal?: AbortSignal;
}): Promise<Readonly<{ contentHash: string; mode: string; size: string }>> {
  throwIfAborted(params.signal);
  const lexical = await fs.lstat(params.filePath, { bigint: true });
  if (!lexical.isFile()) {
    throw new Error(`Codex runtime artifact contains a non-regular file: ${params.filePath}`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(params.filePath, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error(`Codex runtime artifact contains a non-regular file: ${params.filePath}`);
    }
    if (params.budget.fileCount + 1 > MAX_ARTIFACT_FILES) {
      throw new Error("Codex runtime artifact exceeds the bounded file count");
    }
    if (params.budget.totalBytes + before.size > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new Error("Codex runtime artifact exceeds the bounded content size");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let offset = 0n;
    while (offset < before.size) {
      throwIfAborted(params.signal);
      const length = Number(
        before.size - offset < BigInt(buffer.length) ? before.size - offset : BigInt(buffer.length),
      );
      const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
      if (bytesRead === 0) {
        throw new Error(`Codex runtime artifact changed while reading: ${params.filePath}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.stat(params.filePath, { bigint: true });
    if (!sameOpenedFile(before, after) || !sameOpenedFile(after, current)) {
      throw new Error(`Codex runtime artifact changed while reading: ${params.filePath}`);
    }
    params.budget.fileCount += 1;
    params.budget.totalBytes += after.size;
    return {
      contentHash: hash.digest("hex"),
      mode: String(after.mode),
      size: String(after.size),
    };
  } finally {
    await handle.close();
  }
}

async function listPackageFiles(params: {
  rootPath: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const files: string[] = [];
  let entryCount = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    throwIfAborted(params.signal);
    if (depth > MAX_ARTIFACT_DEPTH) {
      throw new Error("Codex runtime artifact exceeds the bounded directory depth");
    }
    const entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries.toSorted((left, right) =>
      compareArtifactNames(left.name, right.name),
    )) {
      throwIfAborted(params.signal);
      entryCount += 1;
      if (entryCount > MAX_ARTIFACT_ENTRIES) {
        throw new Error("Codex runtime artifact exceeds the bounded entry count");
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Codex runtime artifact contains an unsupported entry: ${entryPath}`);
      }
      files.push(normalizeRelativePath(path.relative(params.rootPath, entryPath)));
    }
  };
  await visit(params.rootPath, 0);
  return files;
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function assertNoRuntimeInjectionEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [rawKey, value] of Object.entries(env)) {
    const key = rawKey.toUpperCase();
    if (!value?.trim()) {
      continue;
    }
    if (key === "NODE_OPTIONS" && isSafeNodeOptions(value)) {
      continue;
    }
    if (key === "NODE_OPTIONS") {
      throw new Error(`Codex runtime artifact cannot attest injected runtime environment: ${key}`);
    }
    if (RUNTIME_INJECTION_ENV_KEYS.has(key) || key.startsWith("DYLD_")) {
      // These variables can load code outside the selected launcher/package.
      // Exact setup attestation must fail instead of minting a partial identity.
      throw new Error(`Codex runtime artifact cannot attest injected runtime environment: ${key}`);
    }
  }
}

function isSafeNodeOptions(value: string): boolean {
  const tokens = value.trim().split(/\s+/u);
  const valueFlags = new Set([
    "--max-old-space-size",
    "--max_old_space_size",
    "--max-semi-space-size",
    "--max_semi_space_size",
    "--stack-trace-limit",
  ]);
  const booleanFlags = new Set([
    "--no-deprecation",
    "--no-warnings",
    "--pending-deprecation",
    "--throw-deprecation",
    "--trace-deprecation",
    "--trace-warnings",
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (booleanFlags.has(token)) {
      continue;
    }
    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    if (
      flag === "--disable-warning" &&
      inlineValue &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(inlineValue)
    ) {
      continue;
    }
    if (!valueFlags.has(flag)) {
      return false;
    }
    const numericValue = inlineValue ?? tokens[++index];
    if (!numericValue || !/^\d+$/u.test(numericValue)) {
      return false;
    }
  }
  return tokens.length > 0;
}

async function hashSelectedArtifactFiles(
  descriptor: CodexRuntimeFilesystemDescriptor,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if ((await fs.realpath(descriptor.commandPath)) !== descriptor.commandRealPath) {
    throw new Error("Codex runtime launcher selection changed");
  }
  const packageRoot = descriptor.packageRoot;
  const resolvedPackageRoot = await resolvePackageRoot(descriptor.nativePath);
  if (resolvedPackageRoot !== packageRoot) {
    throw new Error("Codex runtime package selection changed");
  }
  if (packageRoot && (await fs.realpath(packageRoot)) !== packageRoot) {
    throw new Error("Codex runtime package root changed");
  }
  const allFiles = [
    descriptor.commandRealPath,
    ...descriptor.invocationPaths,
    descriptor.nativePath,
    ...(descriptor.codeModeHostPath ? [descriptor.codeModeHostPath] : []),
  ];
  for (const filePath of allFiles) {
    if ((await fs.realpath(filePath)) !== filePath) {
      throw new Error(`Codex runtime artifact file selection changed: ${filePath}`);
    }
  }
  if (descriptor.codeModeHostPath) {
    if ((await fs.realpath(descriptor.codeModeHostCandidatePath)) !== descriptor.codeModeHostPath) {
      throw new Error("Codex code-mode host selection changed");
    }
  } else {
    try {
      await fs.lstat(descriptor.codeModeHostCandidatePath);
      throw new Error("Codex code-mode host selection changed");
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
  const externalFiles = [...new Set(allFiles)]
    .filter((filePath) => !packageRoot || !pathIsWithin(packageRoot, filePath))
    .toSorted(compareArtifactNames);
  const budget: ArtifactHashBudget = { fileCount: 0, totalBytes: 0n };
  const hash = createHash("sha256");
  hash.update("codex-runtime-files-v1\0");
  for (const filePath of externalFiles) {
    const file = await readRegularFileFingerprint({ filePath, budget, signal });
    hash.update(JSON.stringify(["file", filePath, file.mode, file.size, file.contentHash]));
    hash.update("\n");
  }
  if (packageRoot) {
    const beforeFiles = await listPackageFiles({ rootPath: packageRoot, signal });
    for (const relativePath of beforeFiles) {
      const filePath = path.join(packageRoot, ...relativePath.split("/"));
      const file = await readRegularFileFingerprint({ filePath, budget, signal });
      hash.update(
        JSON.stringify(["package", relativePath, file.mode, file.size, file.contentHash]),
      );
      hash.update("\n");
    }
    const afterFiles = await listPackageFiles({ rootPath: packageRoot, signal });
    if (
      beforeFiles.length !== afterFiles.length ||
      beforeFiles.some((filePath, index) => filePath !== afterFiles[index])
    ) {
      throw new Error("Codex runtime package changed while reading");
    }
  }
  if (budget.fileCount === 0) {
    throw new Error("Codex runtime artifact contains no regular files");
  }
  return hash.digest("hex");
}

async function resolveCommandPath(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  let candidate: string | undefined;
  if (process.platform === "win32") {
    candidate = resolveWindowsExecutablePath(command, env);
  } else if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    candidate = path.resolve(cwd, command);
  } else {
    const pathValue = env.PATH;
    if (pathValue === undefined) {
      throw new Error("Codex runtime PATH is unavailable for a bare launcher");
    }
    for (const entry of pathValue.split(path.delimiter)) {
      // POSIX executable lookup treats an empty PATH component as cwd.
      const entryPath =
        entry === "" ? cwd : path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
      const possible = path.join(entryPath, command);
      try {
        await fs.access(possible, fsConstants.X_OK);
        candidate = possible;
        break;
      } catch {
        // Continue through PATH in child-process resolution order.
      }
    }
  }
  if (!candidate) {
    throw new Error(`Codex runtime launcher is unavailable: ${command}`);
  }
  const absolute = path.resolve(candidate);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) {
    throw new Error(`Codex runtime launcher is not a regular file: ${absolute}`);
  }
  return absolute;
}

async function readShebang(filePath: string): Promise<string[] | undefined> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) {
      return undefined;
    }
    const tokens = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) {
      throw new Error("Codex runtime launcher has an invalid shebang");
    }
    return tokens;
  } finally {
    await handle.close();
  }
}

async function resolvePosixInvocationPaths(params: {
  commandRealPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  nativeCommand?: string;
}): Promise<string[]> {
  const paths = [params.commandRealPath];
  const shebang = await readShebang(params.commandRealPath);
  if (!shebang) {
    return paths;
  }
  if (!params.nativeCommand) {
    throw new Error(
      "Codex runtime cannot attest a custom script launcher without its native target",
    );
  }
  const interpreter = await resolveCommandPath(shebang[0]!, params.env, params.cwd);
  paths.push(await fs.realpath(interpreter));
  if (path.basename(interpreter) !== "env") {
    if (shebang.length !== 1) {
      throw new Error("Codex runtime launcher uses unsupported interpreter arguments");
    }
    return paths;
  }
  const envArgs = shebang.slice(1);
  const commandIndex = envArgs[0] === "-S" ? 1 : 0;
  const target = envArgs[commandIndex];
  if (!target || target.startsWith("-") || envArgs.length !== commandIndex + 1) {
    throw new Error("Codex runtime launcher uses unsupported env arguments");
  }
  const targetPath = await resolveCommandPath(target, params.env, params.cwd);
  paths.push(await fs.realpath(targetPath));
  return paths;
}

async function resolvePackageRoot(nativePath: string): Promise<string | undefined> {
  const binDir = path.dirname(nativePath);
  if (path.basename(binDir) !== "bin") {
    return undefined;
  }
  const candidate = path.dirname(binDir);
  const metadataPath = path.join(candidate, "codex-package.json");
  try {
    const metadata = await fs.lstat(metadataPath);
    if (!metadata.isFile()) {
      return undefined;
    }
    const root = await fs.realpath(candidate);
    return pathIsWithin(root, nativePath) ? root : undefined;
  } catch {
    return undefined;
  }
}

async function resolveOptionalRegularFile(filePath: string): Promise<string | undefined> {
  try {
    const canonical = await fs.realpath(filePath);
    const stat = await fs.stat(canonical);
    return stat.isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readEffectiveSpawnEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  if (process.platform !== "win32") {
    return env[name];
  }
  const effectiveKey = Object.keys(env)
    .toSorted(compareArtifactNames)
    .find((key) => key.toUpperCase() === name.toUpperCase());
  return effectiveKey ? env[effectiveKey] : undefined;
}

async function captureFilesystemDescriptor(params: {
  startOptions: CodexAppServerStartOptions;
  spawnIdentity: CodexRuntimeArtifactSpawnIdentity;
  signal?: AbortSignal;
}): Promise<CodexRuntimeFilesystemDescriptor> {
  throwIfAborted(params.signal);
  if (params.startOptions.transport !== "stdio") {
    throw new Error(
      "Verified Codex inference requires a local stdio runtime artifact; WebSocket attestation is unsupported",
    );
  }
  const env = resolveCodexAppServerSpawnEnv(params.startOptions);
  assertNoRuntimeInjectionEnvironment(env);
  // child_process resolves relative launchers and PATH entries after applying cwd.
  // Attestation must use the same base or it can bind bytes that spawn never executes.
  const spawnCwd = path.resolve(params.startOptions.cwd ?? process.cwd());
  const commandPath = await resolveCommandPath(params.startOptions.command, env, spawnCwd);
  const commandRealPath = await fs.realpath(commandPath);
  let invocationPaths: string[];
  if (process.platform === "win32") {
    const program = resolveWindowsSpawnProgram({
      command: params.startOptions.command,
      platform: process.platform,
      env,
      execPath: process.execPath,
      packageName: "@openai/codex",
    });
    if (program.resolution === "node-entrypoint" && !params.spawnIdentity.nativeCommand) {
      throw new Error(
        "Codex runtime cannot attest a custom Node launcher without its native target",
      );
    }
    const invocationCandidates = [commandRealPath, program.command, ...program.leadingArgv];
    invocationPaths = [];
    for (const candidate of invocationCandidates) {
      const resolved = await resolveCommandPath(candidate, env, spawnCwd);
      invocationPaths.push(await fs.realpath(resolved));
    }
  } else {
    invocationPaths = await resolvePosixInvocationPaths({
      commandRealPath,
      env,
      cwd: spawnCwd,
      nativeCommand: params.spawnIdentity.nativeCommand,
    });
  }
  invocationPaths = [...new Set(invocationPaths)].toSorted(compareArtifactNames);
  if (invocationPaths.length > MAX_ARTIFACT_INVOCATION_PATHS) {
    throw new Error("Codex runtime launcher exceeds the bounded invocation file count");
  }
  const nativeCandidate = params.spawnIdentity.nativeCommand ?? invocationPaths[0];
  if (!nativeCandidate) {
    throw new Error("Codex runtime did not resolve a native executable");
  }
  const nativePath = await fs.realpath(await resolveCommandPath(nativeCandidate, env, spawnCwd));
  const packageRoot = await resolvePackageRoot(nativePath);
  const configuredCodeModeHost = readEffectiveSpawnEnvironmentValue(
    env,
    CODE_MODE_HOST_PATH_ENV,
  )?.trim();
  const adjacentCodeModeHost = path.join(
    path.dirname(nativePath),
    process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host",
  );
  const codeModeHostCandidatePath = configuredCodeModeHost
    ? path.isAbsolute(configuredCodeModeHost)
      ? configuredCodeModeHost
      : path.resolve(spawnCwd, configuredCodeModeHost)
    : adjacentCodeModeHost;
  const codeModeHostPath = await resolveOptionalRegularFile(codeModeHostCandidatePath);
  if (configuredCodeModeHost && !codeModeHostPath) {
    throw new Error("Configured Codex code-mode host runtime artifact is unavailable");
  }
  const descriptor: CodexRuntimeFilesystemDescriptor = {
    version: 1,
    commandPath,
    commandRealPath,
    invocationPaths,
    nativePath,
    argsFingerprint: params.spawnIdentity.argsFingerprint,
    ...(packageRoot ? { packageRoot } : {}),
    codeModeHostCandidatePath,
    ...(codeModeHostPath ? { codeModeHostPath } : {}),
    ...(params.spawnIdentity.commandSource
      ? { commandSource: params.spawnIdentity.commandSource }
      : {}),
    ...(params.spawnIdentity.managedCommandOrder
      ? { managedCommandOrder: params.spawnIdentity.managedCommandOrder }
      : {}),
  };
  validateFilesystemDescriptorShape(descriptor);
  return descriptor;
}

function isBoundedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_ARTIFACT_PATH_BYTES &&
    path.isAbsolute(value)
  );
}

function validateFilesystemDescriptorShape(descriptor: CodexRuntimeFilesystemDescriptor): void {
  if (
    descriptor.version !== 1 ||
    !isBoundedPath(descriptor.commandPath) ||
    !isBoundedPath(descriptor.commandRealPath) ||
    !isBoundedPath(descriptor.nativePath) ||
    !isBoundedPath(descriptor.codeModeHostCandidatePath) ||
    !Array.isArray(descriptor.invocationPaths) ||
    descriptor.invocationPaths.length === 0 ||
    descriptor.invocationPaths.length > MAX_ARTIFACT_INVOCATION_PATHS ||
    descriptor.invocationPaths.some((entry) => !isBoundedPath(entry)) ||
    !descriptor.invocationPaths.includes(descriptor.commandRealPath) ||
    !/^[a-f0-9]{64}$/u.test(descriptor.argsFingerprint)
  ) {
    throw new Error("Invalid Codex runtime artifact descriptor");
  }
  if (descriptor.packageRoot) {
    if (
      !isBoundedPath(descriptor.packageRoot) ||
      path.dirname(path.dirname(descriptor.nativePath)) !== descriptor.packageRoot ||
      path.basename(path.dirname(descriptor.nativePath)) !== "bin"
    ) {
      throw new Error("Invalid Codex runtime package descriptor");
    }
  }
  if (descriptor.codeModeHostPath && !isBoundedPath(descriptor.codeModeHostPath)) {
    throw new Error("Invalid Codex code-mode host artifact descriptor");
  }
  if (
    descriptor.commandSource !== undefined &&
    !["managed", "resolved-managed", "config", "env"].includes(descriptor.commandSource)
  ) {
    throw new Error("Invalid Codex runtime command source");
  }
  if (
    descriptor.managedCommandOrder !== undefined &&
    descriptor.managedCommandOrder !== "package-first" &&
    descriptor.managedCommandOrder !== "desktop-first"
  ) {
    throw new Error("Invalid Codex managed command order");
  }
  if (
    descriptor.managedCommandOrder !== undefined &&
    descriptor.commandSource !== "resolved-managed"
  ) {
    throw new Error("Invalid Codex managed runtime descriptor");
  }
  const canonicalInvocationPaths = [...new Set(descriptor.invocationPaths)].toSorted(
    compareArtifactNames,
  );
  if (
    canonicalInvocationPaths.length !== descriptor.invocationPaths.length ||
    canonicalInvocationPaths.some((entry, index) => entry !== descriptor.invocationPaths[index])
  ) {
    throw new Error("Invalid Codex runtime invocation descriptor");
  }
}

function validateArtifactDescriptorShape(descriptor: CodexRuntimeArtifactDescriptor): void {
  validateFilesystemDescriptorShape(descriptor);
  if (
    typeof descriptor.serverVersion !== "string" ||
    descriptor.serverVersion.length === 0 ||
    descriptor.serverVersion.length > 128 ||
    descriptor.serverVersion !== descriptor.serverVersion.trim()
  ) {
    throw new Error("Invalid Codex runtime server version");
  }
  if (
    descriptor.userAgentFingerprint !== undefined &&
    !/^[a-f0-9]{64}$/u.test(descriptor.userAgentFingerprint)
  ) {
    throw new Error("Invalid Codex runtime user-agent fingerprint");
  }
}

function encodeArtifactId(descriptor: CodexRuntimeArtifactDescriptor): string {
  return `${ARTIFACT_ID_PREFIX}${Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url")}`;
}

function decodeArtifactId(id: string): CodexRuntimeArtifactDescriptor {
  if (!id.startsWith(ARTIFACT_ID_PREFIX) || Buffer.byteLength(id, "utf8") > MAX_ARTIFACT_ID_BYTES) {
    throw new Error("Invalid Codex runtime artifact id");
  }
  const encoded = id.slice(ARTIFACT_ID_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("Invalid Codex runtime artifact encoding");
  }
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Codex runtime artifact descriptor");
  }
  const descriptor = parsed as CodexRuntimeArtifactDescriptor;
  const allowedKeys = new Set([
    "version",
    "commandPath",
    "commandRealPath",
    "invocationPaths",
    "nativePath",
    "packageRoot",
    "codeModeHostCandidatePath",
    "codeModeHostPath",
    "argsFingerprint",
    "commandSource",
    "managedCommandOrder",
    "serverVersion",
    "userAgentFingerprint",
  ]);
  if (Object.keys(descriptor).some((key) => !allowedKeys.has(key))) {
    throw new Error("Invalid Codex runtime artifact descriptor fields");
  }
  validateArtifactDescriptorShape(descriptor);
  if (encodeArtifactId(descriptor) !== id) {
    throw new Error("Invalid noncanonical Codex runtime artifact id");
  }
  return descriptor;
}

function fingerprintBinding(
  descriptor: CodexRuntimeArtifactDescriptor,
  contentFingerprint: string,
): string {
  return createHash("sha256")
    .update(ARTIFACT_HASH_DOMAIN)
    .update(JSON.stringify(descriptor))
    .update("\0")
    .update(contentFingerprint)
    .digest("hex");
}

/** Captures exact candidate bytes immediately before app-server startup. */
export async function captureCodexAppServerRuntimeArtifactBeforeStart(params: {
  startOptions: CodexAppServerStartOptions;
  spawnIdentity: CodexRuntimeArtifactSpawnIdentity;
  signal?: AbortSignal;
}): Promise<CodexAppServerRuntimeArtifactCapture> {
  const descriptor = await captureFilesystemDescriptor(params);
  const contentFingerprint = await hashSelectedArtifactFiles(descriptor, params.signal);
  return { descriptor, contentFingerprint };
}

/** Rechecks startup bytes and adds initialized handshake identity. */
export async function finalizeCodexAppServerRuntimeArtifact(params: {
  before: CodexAppServerRuntimeArtifactCapture;
  startOptions: CodexAppServerStartOptions;
  spawnIdentity: CodexRuntimeArtifactSpawnIdentity;
  runtimeIdentity: CodexAppServerRuntimeIdentity | undefined;
  signal?: AbortSignal;
}): Promise<AgentHarnessRuntimeArtifactBinding> {
  const afterDescriptor = await captureFilesystemDescriptor(params);
  const afterContentFingerprint = await hashSelectedArtifactFiles(afterDescriptor, params.signal);
  if (
    JSON.stringify(afterDescriptor) !== JSON.stringify(params.before.descriptor) ||
    afterContentFingerprint !== params.before.contentFingerprint
  ) {
    throw new Error("Codex app-server runtime artifact changed during startup");
  }
  const serverVersion = params.runtimeIdentity?.serverVersion?.trim();
  if (!serverVersion) {
    throw new Error("Codex app-server did not report an initialized runtime identity");
  }
  const userAgent = params.runtimeIdentity?.userAgent;
  const descriptor: CodexRuntimeArtifactDescriptor = {
    ...afterDescriptor,
    serverVersion,
    ...(userAgent
      ? { userAgentFingerprint: createHash("sha256").update(userAgent).digest("hex") }
      : {}),
  };
  validateArtifactDescriptorShape(descriptor);
  const binding = Object.freeze({
    id: encodeArtifactId(descriptor),
    fingerprint: fingerprintBinding(descriptor, afterContentFingerprint),
  });
  return binding;
}

/** Checks current pre-spawn bytes and selection against a previously minted binding. */
export function validateCodexAppServerRuntimeArtifactCapture(
  binding: AgentHarnessRuntimeArtifactBinding,
  capture: CodexAppServerRuntimeArtifactCapture,
): boolean {
  try {
    const expectedDescriptor = decodeArtifactId(binding.id);
    const {
      serverVersion: _serverVersion,
      userAgentFingerprint: _userAgentFingerprint,
      ...expectedFilesystemDescriptor
    } = expectedDescriptor;
    return (
      JSON.stringify(expectedFilesystemDescriptor) === JSON.stringify(capture.descriptor) &&
      binding.fingerprint === fingerprintBinding(expectedDescriptor, capture.contentFingerprint)
    );
  } catch {
    return false;
  }
}

/** Commits a verified binding only after the client has completed auth setup. */
export function bindCodexAppServerRuntimeArtifact(
  client: CodexAppServerClient,
  binding: AgentHarnessRuntimeArtifactBinding,
): void {
  const bindings = getRuntimeArtifactBindings();
  const existing = bindings.get(client);
  if (existing && (existing.id !== binding.id || existing.fingerprint !== binding.fingerprint)) {
    throw new Error("Codex app-server client already has a different runtime artifact");
  }
  bindings.set(client, Object.freeze({ ...binding }));
}

/** Reads the immutable artifact attached to one successfully initialized client. */
export function readCodexAppServerClientRuntimeArtifact(
  client: CodexAppServerClient,
): AgentHarnessRuntimeArtifactBinding | undefined {
  return getRuntimeArtifactBindings().get(client);
}

/** Re-hashes only the exact Codex files named by a server-minted artifact binding. */
export async function validateCodexAppServerRuntimeArtifact(
  binding: AgentHarnessRuntimeArtifactBinding,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const descriptor = decodeArtifactId(binding.id);
    const contentFingerprint = await hashSelectedArtifactFiles(descriptor, signal);
    return binding.fingerprint === fingerprintBinding(descriptor, contentFingerprint);
  } catch {
    return false;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
