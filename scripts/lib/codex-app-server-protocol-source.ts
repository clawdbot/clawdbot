import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const PROTOCOL_SCHEMA_RELATIVE_PATH = "codex-rs/app-server-protocol/schema";

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
  const typescriptRoot = path.join(root, "typescript");
  const jsonRoot = path.join(root, "json");
  const manifestPath = path.join(codexRepo, "codex-rs/Cargo.toml");
  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    runCargoProtocolGenerator(codexRepo, [
      "run",
      "--manifest-path",
      manifestPath,
      "-p",
      "codex-cli",
      "--",
      "app-server",
      "generate-ts",
      "--out",
      typescriptRoot,
      "--experimental",
    ]);
    runCargoProtocolGenerator(codexRepo, [
      "run",
      "--manifest-path",
      manifestPath,
      "-p",
      "codex-cli",
      "--",
      "app-server",
      "generate-json-schema",
      "--out",
      jsonRoot,
      "--experimental",
    ]);
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
  const result = spawnSync("pnpm", ["exec", "oxfmt", "--write", "--threads=1", root], {
    cwd: repoRoot,
    stdio: "inherit",
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
