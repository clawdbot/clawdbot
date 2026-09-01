// Generate Prompt Snapshots script supports OpenClaw repository automation.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { applyPatch, createTwoFilesPatch, FILE_HEADERS_ONLY, parsePatch } from "diff";
import { createHappyPathPromptSnapshotFiles } from "../test/helpers/agents/happy-path-prompt-snapshots.js";
import {
  CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO,
  CODEX_PROMPT_SNAPSHOT_FILES,
  CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
  type CodexPromptSnapshotScenario,
} from "../test/helpers/agents/prompt-snapshot-paths.js";
import { coerceErrorMessage as describeError } from "./lib/error-format.mts";
import {
  deleteStalePromptSnapshotFiles,
  listCommittedSnapshotArtifactPaths,
} from "./prompt-snapshot-files.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oxfmtPath = path.resolve(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "oxfmt.cmd" : "oxfmt",
);
const execFileAsync = promisify(execFile);

type PromptSnapshotFile = Awaited<ReturnType<typeof createHappyPathPromptSnapshotFiles>>[number];
type CodexDynamicToolSnapshotSpec = { name: string };
type CodexDynamicToolSnapshotOverrides = {
  base: string;
  replace: Record<string, CodexDynamicToolSnapshotSpec>;
};

const CODEX_DYNAMIC_TOOL_SNAPSHOT_PREFIX = "codex-dynamic-tools.";
const CODEX_DYNAMIC_TOOL_BASE_SNAPSHOT = `${CODEX_DYNAMIC_TOOL_SNAPSHOT_PREFIX}telegram-direct.json`;
const SHA256_HEADER_PATTERN = /^sha256=([a-f0-9]{64})$/u;

function promptSnapshotEntries(): Array<[CodexPromptSnapshotScenario, string]> {
  return Object.entries(CODEX_PROMPT_SNAPSHOT_FILES) as Array<
    [CodexPromptSnapshotScenario, string]
  >;
}

function resolvePromptSnapshotFileName(scenario: string): string {
  if (!Object.hasOwn(CODEX_PROMPT_SNAPSHOT_FILES, scenario)) {
    throw new Error(`Unknown Codex prompt snapshot scenario: ${scenario}`);
  }
  return CODEX_PROMPT_SNAPSHOT_FILES[scenario as CodexPromptSnapshotScenario];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readSha256Header(header: string | undefined, label: string): string {
  const hash = SHA256_HEADER_PATTERN.exec(header ?? "")?.[1];
  if (!hash) {
    throw new Error(`Invalid Codex prompt snapshot ${label} hash header`);
  }
  return hash;
}

function createCodexPromptSnapshotDelta(scenario: string, base: string, target: string): string {
  const targetFileName = resolvePromptSnapshotFileName(scenario);
  const baseFileName = CODEX_PROMPT_SNAPSHOT_FILES[CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO];
  if (targetFileName === baseFileName) {
    throw new Error("The canonical Codex prompt snapshot does not use a delta");
  }
  return createTwoFilesPatch(
    baseFileName,
    targetFileName,
    base,
    target,
    `sha256=${sha256(base)}`,
    `sha256=${sha256(target)}`,
    { context: 0, headerOptions: FILE_HEADERS_ONLY },
  );
}

/** Strictly materialize one SHA-bound, zero-context prompt snapshot delta. */
export function materializeCodexPromptSnapshotDelta(params: {
  scenario: string;
  base: string;
  delta: string;
}): string {
  const targetFileName = resolvePromptSnapshotFileName(params.scenario);
  const baseFileName = CODEX_PROMPT_SNAPSHOT_FILES[CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO];
  let patches;
  try {
    patches = parsePatch(params.delta);
  } catch (error) {
    throw new Error("Invalid Codex prompt snapshot delta", { cause: error });
  }
  const patch = patches[0];
  if (patches.length !== 1 || !patch) {
    throw new Error("Codex prompt snapshot delta must contain exactly one patch");
  }
  if (patch.oldFileName !== baseFileName || patch.newFileName !== targetFileName) {
    throw new Error("Codex prompt snapshot delta file names do not match the scenario");
  }
  const sourceHash = readSha256Header(patch.oldHeader, "source");
  const targetHash = readSha256Header(patch.newHeader, "target");
  if (sha256(params.base) !== sourceHash) {
    throw new Error("Codex prompt snapshot delta source hash does not match the canonical base");
  }
  const materialized = applyPatch(params.base, patch, {
    fuzzFactor: 0,
    autoConvertLineEndings: false,
  });
  if (materialized === false || sha256(materialized) !== targetHash) {
    throw new Error("Codex prompt snapshot delta did not materialize its target hash");
  }
  if (createCodexPromptSnapshotDelta(params.scenario, params.base, materialized) !== params.delta) {
    throw new Error("Codex prompt snapshot delta is not canonical zero-context output");
  }
  return materialized;
}

function factorCodexPromptSnapshotFiles(files: PromptSnapshotFile[]): PromptSnapshotFile[] {
  const byFileName = new Map(files.map((file) => [path.basename(file.path), file]));
  const baseFileName = CODEX_PROMPT_SNAPSHOT_FILES[CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO];
  const base = byFileName.get(baseFileName);
  if (!base) {
    throw new Error(`Missing canonical Codex prompt snapshot: ${baseFileName}`);
  }
  return files.map((file) => {
    const scenario = promptSnapshotEntries().find(
      ([, fileName]) => fileName === path.basename(file.path),
    );
    if (!scenario || scenario[0] === CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO) {
      return file;
    }
    const delta = createCodexPromptSnapshotDelta(scenario[0], base.content, file.content);
    if (
      materializeCodexPromptSnapshotDelta({
        scenario: scenario[0],
        base: base.content,
        delta,
      }) !== file.content
    ) {
      throw new Error(`Codex prompt snapshot delta roundtrip failed: ${scenario[0]}`);
    }
    return { path: `${file.path}.diff`, content: delta };
  });
}

async function writeSnapshotFiles(root: string, files: PromptSnapshotFile[]) {
  await Promise.all(
    files.map(async (file) => {
      const filePath = path.resolve(root, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content);
    }),
  );
}

async function formatSnapshotFiles(root: string, files: PromptSnapshotFile[]) {
  const filePaths = files
    .filter((file) => file.path.endsWith(".md") || file.path.endsWith(".json"))
    .map((file) => path.resolve(root, file.path));
  if (filePaths.length === 0) {
    return;
  }
  await execFileAsync(oxfmtPath, ["--write", "--threads=1", ...filePaths], {
    cwd: repoRoot,
  });
}

async function readSnapshotFiles(root: string, files: PromptSnapshotFile[]) {
  return await Promise.all(
    files.map(async (file) => ({
      ...file,
      content: await fs.readFile(path.resolve(root, file.path), "utf8"),
    })),
  );
}

/** Keep complete Codex tool specs on the wire; deduplicate only their committed review fixtures. */
function factorCodexDynamicToolSnapshotFiles(files: PromptSnapshotFile[]): PromptSnapshotFile[] {
  const base = files.find((file) => path.basename(file.path) === CODEX_DYNAMIC_TOOL_BASE_SNAPSHOT);
  if (!base) {
    return files;
  }
  const baseTools = JSON.parse(base.content) as CodexDynamicToolSnapshotSpec[];
  if (new Set(baseTools.map((tool) => tool.name)).size !== baseTools.length) {
    return files;
  }

  return files.map((file) => {
    const fileName = path.basename(file.path);
    if (
      fileName === CODEX_DYNAMIC_TOOL_BASE_SNAPSHOT ||
      !fileName.startsWith(CODEX_DYNAMIC_TOOL_SNAPSHOT_PREFIX) ||
      !fileName.endsWith(".json")
    ) {
      return file;
    }
    const tools = JSON.parse(file.content) as CodexDynamicToolSnapshotSpec[];
    if (
      tools.length !== baseTools.length ||
      tools.some((tool, index) => tool.name !== baseTools[index]?.name)
    ) {
      return file;
    }
    const replace = Object.fromEntries(
      tools.flatMap((tool, index) =>
        JSON.stringify(tool) === JSON.stringify(baseTools[index]) ? [] : [[tool.name, tool]],
      ),
    );
    const overrides: CodexDynamicToolSnapshotOverrides = {
      base: CODEX_DYNAMIC_TOOL_BASE_SNAPSHOT,
      replace,
    };
    return { ...file, content: `${JSON.stringify(overrides, null, 2)}\n` };
  });
}

async function formatPromptSnapshotFiles(
  files: PromptSnapshotFile[],
): Promise<PromptSnapshotFile[]> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-snapshots-"));
  try {
    await writeSnapshotFiles(tmpRoot, files);
    await formatSnapshotFiles(tmpRoot, files);
    return await readSnapshotFiles(tmpRoot, files);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function createFormattedPromptSnapshotFiles(): Promise<PromptSnapshotFile[]> {
  const files = await createHappyPathPromptSnapshotFiles();
  const formatted = await formatPromptSnapshotFiles(factorCodexDynamicToolSnapshotFiles(files));
  return factorCodexPromptSnapshotFiles(formatted);
}

/** Materialize one complete, formatted Codex prompt snapshot for human review. */
export async function materializeCodexPromptSnapshot(scenario: string): Promise<string> {
  const targetFileName = resolvePromptSnapshotFileName(scenario);
  const baseFileName = CODEX_PROMPT_SNAPSHOT_FILES[CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO];
  const base = await fs.readFile(
    path.resolve(repoRoot, CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, baseFileName),
    "utf8",
  );
  if (targetFileName === baseFileName) {
    return base;
  }
  const delta = await fs.readFile(
    path.resolve(repoRoot, CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, `${targetFileName}.diff`),
    "utf8",
  );
  return materializeCodexPromptSnapshotDelta({ scenario, base, delta });
}

/** Materialize one complete, formatted Codex dynamic-tool catalog for human review. */
export async function materializeCodexDynamicToolSnapshot(scenario: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/u.test(scenario)) {
    throw new Error(`Invalid Codex dynamic-tool snapshot scenario: ${scenario}`);
  }
  const snapshotPath = path.join(
    CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
    `${CODEX_DYNAMIC_TOOL_SNAPSHOT_PREFIX}${scenario}.json`,
  );
  const snapshot = JSON.parse(await fs.readFile(path.resolve(repoRoot, snapshotPath), "utf8")) as
    | CodexDynamicToolSnapshotSpec[]
    | CodexDynamicToolSnapshotOverrides;
  let tools: CodexDynamicToolSnapshotSpec[];
  if (Array.isArray(snapshot)) {
    tools = snapshot;
  } else {
    if (snapshot.base !== CODEX_DYNAMIC_TOOL_BASE_SNAPSHOT) {
      throw new Error(`Unsupported Codex dynamic-tool snapshot base: ${snapshot.base}`);
    }
    const basePath = path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, snapshot.base);
    const base = JSON.parse(await fs.readFile(path.resolve(repoRoot, basePath), "utf8")) as
      | CodexDynamicToolSnapshotSpec[]
      | CodexDynamicToolSnapshotOverrides;
    if (!Array.isArray(base)) {
      throw new Error("The canonical Codex dynamic-tool snapshot must contain complete tools");
    }
    const baseNames = new Set(base.map((tool) => tool.name));
    for (const [name, replacement] of Object.entries(snapshot.replace)) {
      if (!baseNames.has(name) || replacement.name !== name) {
        throw new Error(`Invalid Codex dynamic-tool snapshot replacement: ${name}`);
      }
    }
    tools = base.map((tool) =>
      Object.hasOwn(snapshot.replace, tool.name) ? snapshot.replace[tool.name]! : tool,
    );
  }
  const [formatted] = await formatPromptSnapshotFiles([
    { path: snapshotPath, content: `${JSON.stringify(tools, null, 2)}\n` },
  ]);
  if (!formatted) {
    throw new Error(`Failed to materialize Codex dynamic-tool snapshot: ${scenario}`);
  }
  return formatted.content;
}

async function writeSnapshots() {
  const files = await createFormattedPromptSnapshotFiles();
  await fs.mkdir(path.resolve(repoRoot, CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR), {
    recursive: true,
  });
  const deleted = await deleteStalePromptSnapshotFiles(repoRoot, files);
  await writeSnapshotFiles(repoRoot, files);
  const deletedSummary = deleted.length > 0 ? ` Deleted ${deleted.length} stale file(s).` : "";
  console.log(`Wrote ${files.length} prompt snapshot files.${deletedSummary}`);
}

async function checkSnapshots() {
  const files = await createFormattedPromptSnapshotFiles();
  const expectedPaths = new Set(files.map((file) => file.path));
  const mismatches: string[] = [];
  for (const file of files) {
    const filePath = path.resolve(repoRoot, file.path);
    let actual: string;
    try {
      actual = await fs.readFile(filePath, "utf8");
    } catch (error) {
      mismatches.push(`${file.path}: missing (${describeError(error)})`);
      continue;
    }
    if (actual !== file.content) {
      mismatches.push(`${file.path}: differs from generated output`);
    }
  }
  for (const snapshotPath of await listCommittedSnapshotArtifactPaths(repoRoot)) {
    if (!expectedPaths.has(snapshotPath)) {
      mismatches.push(`${snapshotPath}: stale file (not generated)`);
    }
  }
  if (mismatches.length > 0) {
    console.error("Prompt snapshot drift detected. Run `pnpm prompt:snapshots:gen`.");
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Prompt snapshots are current (${files.length} files).`);
}

async function runPromptSnapshotGenerator(argv = process.argv.slice(2)) {
  if (argv[0] === "--materialize-prompt") {
    const scenario = argv[1];
    if (!scenario || argv.length !== 2) {
      console.error(
        "Usage: node --import tsx scripts/generate-prompt-snapshots.ts --materialize-prompt <scenario>",
      );
      process.exitCode = 2;
      return;
    }
    process.stdout.write(await materializeCodexPromptSnapshot(scenario));
    return;
  }
  if (argv[0] === "--materialize") {
    const scenario = argv[1];
    if (!scenario || argv.length !== 2) {
      console.error(
        "Usage: node --import tsx scripts/generate-prompt-snapshots.ts --materialize <scenario>",
      );
      process.exitCode = 2;
      return;
    }
    process.stdout.write(await materializeCodexDynamicToolSnapshot(scenario));
    return;
  }
  const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : undefined;

  if (!mode) {
    console.error("Usage: pnpm prompt:snapshots:gen | pnpm prompt:snapshots:check");
    process.exitCode = 2;
    return;
  }

  if (mode === "write") {
    await writeSnapshots();
  } else {
    await checkSnapshots();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await runPromptSnapshotGenerator();
}
