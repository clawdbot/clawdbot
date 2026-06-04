import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePnpmRunner } from "../pnpm-runner.mjs";

const PROTOCOL_SCHEMA_RELATIVE_PATH = "codex-rs/app-server-protocol/schema";
const DEFAULT_PROTOCOL_GENERATION_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024;

export const selectedCodexAppServerJsonSchemas = [
  "DynamicToolCallParams.json",
  "v2/ErrorNotification.json",
  "v2/GetAccountResponse.json",
  "v2/ModelListResponse.json",
  "v2/ThreadResumeResponse.json",
  "v2/ThreadStartResponse.json",
  "v2/TurnCompletedNotification.json",
  "v2/TurnStartResponse.json",
] as const;

export type GeneratedCodexAppServerProtocolSource = {
  root: string;
  codexRepo: string;
  typescriptRoot: string;
  jsonRoot: string;
  cleanup: () => Promise<void>;
};

type PnpmCommand = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};

type ResolvePnpmCommandOptions = {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
};

function resolveEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function resolveCodexProtocolPnpmCommand(
  args: string[],
  options: ResolvePnpmCommandOptions = {},
): PnpmCommand {
  const env = options.env ?? process.env;
  const command = resolvePnpmRunner({
    comSpec: options.comSpec ?? resolveEnvValue(env, "ComSpec"),
    npmExecPath: options.npmExecPath ?? env.npm_execpath,
    nodeExecPath: options.execPath ?? process.execPath,
    platform: options.platform,
    pnpmArgs: args,
  });
  if (command.env === undefined) {
    const invocation = { ...command };
    delete invocation.env;
    return invocation;
  }
  return command;
}

export function buildCodexProtocolExportArgs(manifestPath: string, outDir: string): string[] {
  return [
    "run",
    "--manifest-path",
    manifestPath,
    "-p",
    "codex-app-server-protocol",
    "--bin",
    "export",
    "--",
    "--out",
    outDir,
    "--experimental",
  ];
}

export function resolveCodexProtocolMinFreeBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PROTOCOL_GENERATION_MIN_FREE_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES must be a non-negative byte count, got ${raw}`,
    );
  }
  return Math.floor(parsed);
}

export function resolveCodexProtocolCargoTargetDir(
  codexRepo: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const targetDir = env.CARGO_TARGET_DIR ?? env.CARGO_BUILD_TARGET_DIR;
  if (targetDir !== undefined && targetDir.trim() !== "") {
    return path.isAbsolute(targetDir) ? path.resolve(targetDir) : path.resolve(codexRepo, targetDir);
  }
  return path.join(codexRepo, "codex-rs", "target");
}

export function validateCodexProtocolGenerationHeadroom(params: {
  freeBytes: number;
  minFreeBytes: number;
  pathLabel: string;
}): void {
  if (params.minFreeBytes <= 0 || params.freeBytes >= params.minFreeBytes) {
    return;
  }

  throw new Error(
    [
      "Codex app-server protocol generation needs Rust build headroom before running cargo.",
      `${params.pathLabel} has ${formatBytes(params.freeBytes)} free; requires at least ${formatBytes(
        params.minFreeBytes,
      )}.`,
      "Run this check on Crabbox/Testbox, free local disk, or set OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES=0 to override intentionally.",
    ].join("\n"),
  );
}

export async function resolveCodexAppServerProtocolSource(repoRoot: string): Promise<{
  codexRepo: string;
  sourceRoot: string;
}> {
  const candidates = await collectCodexRepoCandidates(repoRoot);
  const checked: string[] = [];

  for (const candidate of candidates) {
    const codexRepo = path.resolve(candidate);
    if (checked.includes(codexRepo)) {
      continue;
    }
    checked.push(codexRepo);
    const sourceRoot = path.join(codexRepo, PROTOCOL_SCHEMA_RELATIVE_PATH);
    if (await isDirectory(path.join(sourceRoot, "typescript"))) {
      return { codexRepo, sourceRoot };
    }
  }

  throw new Error(
    [
      "Codex app-server protocol schema not found.",
      "Set OPENCLAW_CODEX_REPO to a checkout of openai/codex, or keep a sibling `codex` checkout next to the primary OpenClaw checkout.",
      `Checked: ${checked.join(", ") || "<none>"}`,
    ].join("\n"),
  );
}

export async function generateExperimentalCodexAppServerProtocolSource(
  repoRoot = process.cwd(),
): Promise<GeneratedCodexAppServerProtocolSource> {
  const { codexRepo } = await resolveCodexAppServerProtocolSource(repoRoot);
  const root = await fs.mkdtemp(path.join(repoRoot, ".tmp-codex-app-server-protocol-"));
  const generatedRoot = path.join(root, "generated");
  const typescriptRoot = path.join(root, "typescript");
  const jsonRoot = path.join(root, "json");
  const manifestPath = path.join(codexRepo, "codex-rs/Cargo.toml");
  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    await assertCodexProtocolGenerationHeadroom({ codexRepo, repoRoot });
    runCargoProtocolGenerator(codexRepo, buildCodexProtocolExportArgs(manifestPath, generatedRoot));
    await splitGeneratedProtocolOutput(generatedRoot, { jsonRoot, typescriptRoot });
    await rewriteTypeScriptImports(typescriptRoot);
    formatGeneratedTypeScript(repoRoot, typescriptRoot);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    root,
    codexRepo,
    typescriptRoot,
    jsonRoot,
    cleanup,
  };
}

async function collectCodexRepoCandidates(repoRoot: string): Promise<string[]> {
  const candidates = [
    process.env.OPENCLAW_CODEX_REPO,
    path.resolve(repoRoot, "../codex"),
    await resolvePrimaryWorktreeSiblingCodex(repoRoot),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

async function resolvePrimaryWorktreeSiblingCodex(repoRoot: string): Promise<string | undefined> {
  const gitFilePath = path.join(repoRoot, ".git");
  let gitFile: string;
  try {
    gitFile = await fs.readFile(gitFilePath, "utf8");
  } catch {
    return undefined;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(gitFile);
  if (!match) {
    return undefined;
  }

  const gitDir = path.resolve(repoRoot, match[1].trim());
  const worktreeMarker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const markerIndex = gitDir.indexOf(worktreeMarker);
  if (markerIndex < 0) {
    return undefined;
  }

  const primaryWorktreeRoot = gitDir.slice(0, markerIndex);
  return path.join(path.dirname(primaryWorktreeRoot), "codex");
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function assertCodexProtocolGenerationHeadroom(params: {
  codexRepo: string;
  repoRoot: string;
}): Promise<void> {
  const minFreeBytes = resolveCodexProtocolMinFreeBytes();
  if (minFreeBytes <= 0) {
    return;
  }

  const checks = [
    { path: params.repoRoot, label: "protocol output checkout" },
    {
      path: resolveCodexProtocolCargoTargetDir(params.codexRepo),
      label: "Cargo target directory",
    },
  ];
  for (const check of checks) {
    const statsPath = await resolveExistingStatfsPath(check.path);
    const stats = await fs.statfs(statsPath);
    validateCodexProtocolGenerationHeadroom({
      freeBytes: stats.bavail * stats.bsize,
      minFreeBytes,
      pathLabel: check.label,
    });
  }
}

function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) {
    return `${gib.toFixed(1)} GiB`;
  }
  return `${Math.floor(bytes / (1024 * 1024))} MiB`;
}

async function resolveExistingStatfsPath(targetPath: string): Promise<string> {
  let currentPath = path.resolve(targetPath);
  while (true) {
    try {
      await fs.stat(currentPath);
      return currentPath;
    } catch {
      const parent = path.dirname(currentPath);
      if (parent === currentPath) {
        throw new Error(`Cannot find an existing parent directory for ${targetPath}`);
      }
      currentPath = parent;
    }
  }
}

async function splitGeneratedProtocolOutput(
  sourceRoot: string,
  roots: { jsonRoot: string; typescriptRoot: string },
): Promise<void> {
  await copyGeneratedProtocolFiles(sourceRoot, sourceRoot, roots);
}

async function copyGeneratedProtocolFiles(
  sourceRoot: string,
  currentRoot: string,
  roots: { jsonRoot: string; typescriptRoot: string },
): Promise<void> {
  const entries = await fs.readdir(currentRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(currentRoot, entry.name);
      if (entry.isDirectory()) {
        await copyGeneratedProtocolFiles(sourceRoot, sourcePath, roots);
        return;
      }
      if (!entry.isFile()) {
        return;
      }

      const relativePath = path.relative(sourceRoot, sourcePath);
      const targetRoot = entry.name.endsWith(".ts")
        ? roots.typescriptRoot
        : entry.name.endsWith(".json")
          ? roots.jsonRoot
          : null;
      if (targetRoot === null) {
        return;
      }

      const targetPath = path.join(targetRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }),
  );
}

function runCargoProtocolGenerator(codexRepo: string, args: string[]): void {
  const result = spawnSync("cargo", args, {
    cwd: codexRepo,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`cargo ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function formatGeneratedTypeScript(repoRoot: string, root: string): void {
  const command = resolveCodexProtocolPnpmCommand([
    "exec",
    "oxfmt",
    "--write",
    "--threads=1",
    root,
  ]);
  const result = spawnSync(command.command, command.args, {
    cwd: repoRoot,
    env: command.env ?? process.env,
    shell: command.shell,
    stdio: "inherit",
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm exec oxfmt --write --threads=1 ${root} failed with exit code ${
        result.status ?? "unknown"
      }`,
    );
  }
}

export async function rewriteTypeScriptImports(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await rewriteTypeScriptImports(fullPath);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return;
      }
      const text = await fs.readFile(fullPath, "utf8");
      await fs.writeFile(fullPath, normalizeGeneratedTypeScript(text));
    }),
  );
}

export function normalizeGeneratedTypeScript(text: string): string {
  return text
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(\.js)?(["'])/g, "$1$2.js$4")
    .replace('export * as v2 from "./v2.js";', 'export * as v2 from "./v2/index.js";')
    .replaceAll("| null | null", "| null");
}
