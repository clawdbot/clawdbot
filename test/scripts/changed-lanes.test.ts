// Changed Lanes tests cover changed lanes script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyChangedLanes,
  detectChangedLanes,
  hasDeadcodeScannedSource,
  isChangedLaneTestPath,
  isLiveDockerPackageScriptOnlyChange,
  isPackageScriptOnlyChange,
  listChangedPathsFromGit,
  listStagedChangedPaths,
} from "../../scripts/changed-lanes.mts";
import {
  buildChangedCheckCrabboxArgs,
  changedCheckLocalDependenciesReady,
  changedCheckRequiresRemote,
  cleanupCorepackPnpmShimDir,
  createChangedCheckChildEnv,
  createChangedCheckPlan,
  createPnpmManagedCommand,
  createTargetedCoreLintCommand,
  createTargetedExtensionLintCommand,
  createTargetedScriptLintCommand,
  shouldDelegateChangedCheckToCrabbox,
  shouldRunAppcastOwnerTest,
  shouldRunCanvasA2uiNativeResourceCheck,
  shouldRunControlUiI18nVerify,
  shouldRunPromptSnapshotCheck,
  shouldRunPromptSnapshotOwnerTest,
  shouldRunDoctorContractOwnerTests,
  shouldRunRuntimeSidecarBaselineCheck,
  shouldRunNpmLockGuard,
  shouldRunPluginSdkApiBaselineCheck,
  shouldRunDeprecationHygieneChecks,
  shouldRunPluginSdkSurfaceChecks,
  shouldRunSqliteSessionSchemaBaselineCheck,
  shouldRunTestTempCreationReport,
  shouldRunWrapperShadowingCheck,
  createNpmLockGuardCommand,
  delegationFailedBeforeRunning,
  resolveChangedCheckProofArtifactPath,
} from "../../scripts/check-changed.mts";
import { resolveOxfmtInvocation } from "../../scripts/format-docs.mts";
import {
  commandFamily,
  createCheckProofReceipt,
  createCheckProofReceiptBundleFromDir,
  decodeCheckProofReceiptBundleFromEnv,
  encodeCheckProofReceiptBundleForEnv,
  createWrapperProof,
  importCheckProofReceiptBundle,
  readCheckProofReceiptBundleFromArtifactTarball,
  type DescendantProofPlan,
  type DescendantProofReuseOptions,
  evaluateReusableReceipt,
  isReusableCheckProofReceipt,
  readWrapperProofReceipt,
  writeCheckProofReceipt,
  writeWrapperProofReceipt,
  type CheckProofReceipt,
} from "../../scripts/lib/check-proof-reuse.mts";
import { isDirectRunPath } from "../../scripts/lib/direct-run.mjs";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
type ExecFileSyncFailure = Error & { status?: number | null; stderr?: Buffer };
const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

function createNestedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return env;
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  }).trim();

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

function expectLanes(
  lanes: ReturnType<typeof createEmptyChangedLanes>,
  expected: Partial<ReturnType<typeof createEmptyChangedLanes>>,
) {
  expect(lanes).toEqual({ ...createEmptyChangedLanes(), ...expected });
}

function parseChangedLaneOutput(output: string): {
  paths: string[];
  lanes: ReturnType<typeof createEmptyChangedLanes>;
} {
  return JSON.parse(output) as {
    paths: string[];
    lanes: ReturnType<typeof createEmptyChangedLanes>;
  };
}

function runChangedLanesCli(cwd: string, args: string[]) {
  return parseChangedLaneOutput(
    execFileSync(process.execPath, [path.join(repoRoot, "scripts", "changed-lanes.mjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: createNestedGitEnv(),
    }),
  );
}

function runRepoScript(script: string, args: string[], env = createNestedGitEnv()) {
  const nodeArgs = script.endsWith(".mts")
    ? ["--import", "tsx", script, ...args]
    : [script, ...args];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function writeRepoFile(repoDir: string, filePath: string, contents: string): void {
  const absolutePath = path.join(repoDir, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const emptyProofBundleJson =
  '{"schemaVersion":1,"artifact":"changed-check evidence receipt bundle","receipts":[],"digest":"fbc8f7c0412a18f1e1a1b82206a9dbc886fe8bc4e2a6819bfe9c2348464b7faa"}';

function writeFakeSuccessfulCrabboxNode(binDir: string): void {
  writeFileSync(
    path.join(binDir, "node"),
    [
      "#!/bin/sh",
      "set -eu",
      "export_path=",
      "lease=tbx_fake",
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--artifact-glob" ]; then',
      "    shift",
      '    export_path="$1"',
      "  fi",
      "  shift || true",
      "done",
      'if [ -z "$export_path" ]; then exit 1; fi',
      'mkdir -p "$(dirname "$export_path")" ".crabbox/runs/$lease"',
      `printf '%s' ${JSON.stringify(emptyProofBundleJson)} > "$export_path"`,
      'tar -czf ".crabbox/runs/$lease/blacksmith-artifacts.tgz" "$export_path"',
      'printf \'{"provider":"blacksmith-testbox","leaseId":"%s","exitCode":0,"artifacts":[{"kind":"artifact-glob","path":"%s/.crabbox/runs/%s/blacksmith-artifacts.tgz"}]}\\n\' "$lease" "$PWD" "$lease" >&2',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function writeFakeLifecycleCrabboxNode(binDir: string): void {
  const fakeRunnerPath = path.join(binDir, "fake-crabbox-runner.mjs");
  const fakeProofWriterPath = path.join(binDir, "fake-tsgo-proof-writer.mjs");
  writeFileSync(
    path.join(binDir, "node"),
    [
      "#!/bin/sh",
      "set -eu",
      'if [ "${1:-}" = "scripts/crabbox-wrapper.mjs" ]; then',
      '  exec "$REAL_NODE" "$FAKE_CRABBOX_RUNNER" "$@"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(binDir, "corepack"),
    [
      "#!/bin/sh",
      "set -eu",
      'if [ "${1:-}" != "pnpm" ]; then',
      '  echo "unexpected corepack command: $*" >&2',
      "  exit 1",
      "fi",
      "shift",
      'command="${1:-}"',
      "shift || true",
      'if [ "$command" = "check:changed" ]; then',
      '  exec "$REAL_NODE" "$REPO_ROOT/scripts/check-changed.mjs" "$@"',
      "fi",
      'if [ "$command" = "tsgo:core" ]; then',
      "  count=0",
      '  if [ -f "$HEAVY_COUNT_PATH" ]; then count="$(cat "$HEAVY_COUNT_PATH")"; fi',
      "  count=$((count + 1))",
      '  printf "%s\\n" "$count" > "$HEAVY_COUNT_PATH"',
      '  exec "$REAL_NODE" --import "$TSX_IMPORT" "$FAKE_TSGO_PROOF_WRITER" -p tsconfig.core.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core.tsbuildinfo',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    fakeRunnerPath,
    [
      "import { spawnSync, execFileSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      "",
      "const args = process.argv.slice(2);",
      "let exportPath = '';",
      "let separator = -1;",
      "for (let index = 0; index < args.length; index += 1) {",
      "  if (args[index] === '--artifact-glob') {",
      "    exportPath = args[index + 1] ?? '';",
      "    index += 1;",
      "  } else if (args[index] === '--') {",
      "    separator = index;",
      "    break;",
      "  }",
      "}",
      "if (!exportPath || separator === -1) {",
      "  process.exit(1);",
      "}",
      "const env = { ...process.env };",
      "let commandIndex = separator + 1;",
      "while (commandIndex < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(args[commandIndex] ?? '')) {",
      "  const raw = args[commandIndex] ?? '';",
      "  const equals = raw.indexOf('=');",
      "  env[raw.slice(0, equals)] = raw.slice(equals + 1);",
      "  if (raw.startsWith('OPENCLAW_CHECK_CHANGED_PRIOR_RECEIPTS_B64=')) {",
      "    fs.writeFileSync(env.CAPTURE_BUNDLE_PATH, raw.slice(equals + 1));",
      "  }",
      "  commandIndex += 1;",
      "}",
      "const command = args.slice(commandIndex);",
      "const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-check-remote-'));",
      "execFileSync('git', ['clone', '--quiet', '--no-local', process.cwd(), remoteDir], { stdio: 'ignore' });",
      "env.PATH = `${env.FAKE_BIN_DIR}${path.delimiter}${env.PATH ?? ''}`;",
      "const result = spawnSync(command[0], command.slice(1), { cwd: remoteDir, env, encoding: 'utf8' });",
      "if (result.stdout) process.stdout.write(result.stdout);",
      "if (result.stderr) process.stderr.write(result.stderr);",
      "const lease = `tbx_lifecycle_${Date.now()}`;",
      "const tarball = path.resolve(process.cwd(), '.crabbox', 'runs', lease, 'blacksmith-artifacts.tgz');",
      "fs.mkdirSync(path.dirname(tarball), { recursive: true });",
      "if (result.status === 0) {",
      "  execFileSync('tar', ['-czf', tarball, '-C', remoteDir, exportPath], { stdio: 'ignore' });",
      "}",
      "const report = {",
      "  provider: 'blacksmith-testbox',",
      "  leaseId: lease,",
      "  exitCode: result.status ?? 1,",
      "  artifacts: result.status === 0 ? [{ kind: 'artifact-glob', path: tarball }] : [],",
      "};",
      "process.stderr.write(`${JSON.stringify(report)}\\n`);",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    fakeProofWriterPath,
    [
      `import { createTsgoWrapperProofForArgs } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/run-tsgo.mts")).href)};`,
      `import { writeWrapperProofReceipt } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/check-proof-reuse.mts")).href)};`,
      "",
      "const { proof, sparseGuardError } = createTsgoWrapperProofForArgs(process.argv.slice(2), process.env);",
      "if (sparseGuardError) {",
      "  console.error(sparseGuardError);",
      "  process.exit(1);",
      "}",
      "writeWrapperProofReceipt(process.env.OPENCLAW_TOOL_PROOF_RECEIPT, proof);",
      "",
    ].join("\n"),
    "utf8",
  );
}

function createProofRepo(prefix: string) {
  const dir = makeTempRepoRoot(tempDirs, prefix);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  const files: Record<string, string> = {
    ".gitignore": ".artifacts/\n.crabbox/\n",
    ".oxlintrc.json": "{}\n",
    "config/oxlint/boundary-guards.json": "{}\n",
    "config/tsconfig/oxlint.json": "{}\n",
    "config/tsconfig/oxlint.core.json": "{}\n",
    "config/tsconfig/oxlint.extensions.json": "{}\n",
    "config/tsconfig/oxlint.scripts.json": "{}\n",
    "package.json": prettyJson({
      name: "proof-repo",
      version: "0.0.0",
      scripts: {
        "tsgo:core":
          "node scripts/run-tsgo.mjs -p tsconfig.core.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core.tsbuildinfo",
        "tsgo:core:test":
          "node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.core.test.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core-test.tsbuildinfo",
        "tsgo:extensions":
          "node scripts/run-tsgo.mjs -p tsconfig.extensions.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/extensions.tsbuildinfo",
        "tsgo:extensions:test":
          "node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.extensions.test.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/extensions-test.tsbuildinfo",
        "tsgo:scripts":
          "node scripts/run-tsgo.mjs -p tsconfig.scripts.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/scripts.tsbuildinfo",
      },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "scripts/changed-lanes.mjs": "export {};\n",
    "scripts/changed-lanes.mts": "export {};\n",
    "scripts/check-changed.mjs": "export {};\n",
    "scripts/check-changed.mts": "export {};\n",
    "scripts/lib/check-proof-reuse.mts": "export {};\n",
    "scripts/lib/local-heavy-check-runtime.mts": "export {};\n",
    "scripts/lib/managed-child-process.mts": "export {};\n",
    "scripts/lib/tsgo-sparse-guard.mts": "export {};\n",
    "scripts/lib/tsx-cli-shim.mjs": "export {};\n",
    "scripts/run-oxlint-shards.mts": "export {};\n",
    "scripts/run-oxlint.mjs": "export {};\n",
    "scripts/run-oxlint.mts": "export {};\n",
    "scripts/run-tsgo.mjs": "export {};\n",
    "scripts/run-tsgo.mts": "export {};\n",
    "src/core.ts": "export const core = 1;\n",
    "src/plugin-sdk/api.ts": "export const api = 1;\n",
    "tsconfig.core.json": "{}\n",
    "tsconfig.extensions.json": "{}\n",
    "tsconfig.scripts.json": "{}\n",
  };
  for (const [filePath, contents] of Object.entries(files)) {
    writeRepoFile(dir, filePath, contents);
  }
  commitAll(dir, "base");
  return {
    base: git(dir, ["rev-parse", "HEAD"]),
    dir,
    receiptDir: makeTempRepoRoot(tempDirs, `${prefix}receipts-`),
  };
}

function createDescendantPlanForTest(
  _cwd: string,
  params: { currentHead: string; paths: string[]; producerHead: string },
): DescendantProofPlan {
  const result = detectChangedLanes(params.paths);
  const plan = createChangedCheckPlan(result, {
    base: params.producerHead,
    env: createChangedCheckChildEnv({ PATH: "/usr/bin" }),
    head: params.currentHead,
  });
  return {
    commands: plan.commands.map((command) =>
      command.bin ? { ...command, bin: command.bin } : createPnpmManagedCommand(command),
    ),
    lanesAll: result.lanes.all,
    releaseMetadataOnly: result.lanes.releaseMetadata,
  };
}

function createDescendantOptionsForTest(cwd: string): DescendantProofReuseOptions {
  return {
    cwd,
    createDescendantPlan: (params) => createDescendantPlanForTest(cwd, params),
  };
}

type PlannedProof = {
  command: ReturnType<typeof createPnpmManagedCommand>;
  commands: ReturnType<typeof createChangedCheckPlan>["commands"];
  summary: string;
};

function createManagedPlanForTest(
  _cwd: string,
  params: { base: string; head: string; paths: string[] },
): PlannedProof {
  const result = detectChangedLanes(params.paths);
  const plan = createChangedCheckPlan(result, {
    base: params.base,
    env: createChangedCheckChildEnv({ PATH: "/usr/bin" }),
    head: params.head,
  });
  const command = expectDefined(
    plan.commands.find((candidate) => candidate.name.startsWith("typecheck")),
    "typecheck proof command",
  );
  return {
    command: command.bin
      ? ({ ...command, bin: command.bin } as ReturnType<typeof createPnpmManagedCommand>)
      : createPnpmManagedCommand(command),
    commands: plan.commands,
    summary: plan.summary,
  };
}

function createWrapperProofForCommand(commandName: string, cwd: string) {
  const argvByCommand: Record<string, string[]> = {
    "typecheck core": [
      "-p",
      "tsconfig.core.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/core.tsbuildinfo",
    ],
    "typecheck core tests": [
      "-p",
      "test/tsconfig/tsconfig.core.test.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/core-test.tsbuildinfo",
    ],
    "typecheck extension tests": [
      "-p",
      "test/tsconfig/tsconfig.extensions.test.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/extensions-test.tsbuildinfo",
    ],
    "typecheck extensions": [
      "-p",
      "tsconfig.extensions.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/extensions.tsbuildinfo",
    ],
    "typecheck scripts": [
      "-p",
      "tsconfig.scripts.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/scripts.tsbuildinfo",
    ],
  };
  return createWrapperProof({
    tool: "tsgo",
    wrapper: "scripts/run-tsgo.mts",
    argv: expectDefined(argvByCommand[commandName], `wrapper argv for ${commandName}`),
    cwd,
  });
}

function createStoredProof(params: {
  commandName: string;
  producerContents: string;
  producerPath: string;
}) {
  const repo = createProofRepo("changed-check-descendant-");
  writeRepoFile(repo.dir, params.producerPath, params.producerContents);
  commitAll(repo.dir, "producer");
  const producerHead = git(repo.dir, ["rev-parse", "HEAD"]);
  const plan = createManagedPlanForTest(repo.dir, {
    base: repo.base,
    head: producerHead,
    paths: [params.producerPath],
  });
  const command =
    plan.command.name === params.commandName
      ? plan.command
      : expectDefined(
          createDescendantPlanForTest(repo.dir, {
            currentHead: producerHead,
            paths: [params.producerPath],
            producerHead: repo.base,
          }).commands.find((candidate) => candidate.name === params.commandName),
          params.commandName,
        );
  const wrapperProof = createWrapperProofForCommand(params.commandName, repo.dir);
  const receipt = createCheckProofReceipt({
    command,
    context: {
      base: repo.base,
      changedPaths: [params.producerPath],
      cwd: repo.dir,
      head: producerHead,
      planCommands: plan.commands,
      planSummary: plan.summary,
    },
    exitCode: 0,
    expectedWrapperProof: wrapperProof,
    wrapperProof,
  });
  writeCheckProofReceipt(repo.receiptDir, receipt);
  return { ...repo, command, commandName: params.commandName, producerHead, receipt, wrapperProof };
}

function createExpectedProof(params: {
  currentPaths: string[];
  fixture: ReturnType<typeof createStoredProof>;
  wrapperProof?: ReturnType<typeof createWrapperProof>;
}) {
  const head = git(params.fixture.dir, ["rev-parse", "HEAD"]);
  const plan = createManagedPlanForTest(params.fixture.dir, {
    base: params.fixture.base,
    head,
    paths: params.currentPaths,
  });
  const wrapperProof =
    params.wrapperProof ??
    createWrapperProofForCommand(params.fixture.commandName, params.fixture.dir);
  return createCheckProofReceipt({
    command: params.fixture.command,
    context: {
      base: params.fixture.base,
      changedPaths: params.currentPaths,
      cwd: params.fixture.dir,
      head,
      planCommands: plan.commands,
      planSummary: plan.summary,
    },
    exitCode: 0,
    expectedWrapperProof: wrapperProof,
    wrapperProof,
  });
}

// Executes the exact "format changed files" plan command with the repo-pinned oxfmt,
// reconstructing `pnpm format:check <plan args>`. Guards the runtime verdict, not just
// plan construction: a misformatted added file must fail, deleted paths must not.
function runChangedFormatLaneWithRepoOxfmt(cwd: string, changedPaths: string[]) {
  const plan = createChangedCheckPlan(detectChangedLanes(changedPaths));
  const formatCommand = plan.commands.find((command) => command.name === "format changed files");
  expect(formatCommand?.args[0]).toBe("format:check");
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const formatScript = expectDefined(
    packageJson.scripts["format:check"],
    "format:check package script",
  );
  const [rawScriptBin, ...scriptArgs] = formatScript.split(" ");
  const scriptBin = expectDefined(rawScriptBin, "format:check script binary");
  expect(scriptBin).toBe("oxfmt");
  const invocation = resolveOxfmtInvocation(
    [...scriptArgs, ...(formatCommand?.args.slice(1) ?? [])],
    { repoRoot },
  );
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

function writeSingleEntryTarGz(
  tarballPath: string,
  entry: { name: string; body?: string; typeflag?: string; linkname?: string },
) {
  const body = Buffer.from(entry.body ?? "", "utf8");
  const header = Buffer.alloc(512);
  const write = (offset: number, length: number, value: string) => {
    header.write(value.slice(0, length), offset, length, "utf8");
  };
  const writeOctal = (offset: number, length: number, value: number) => {
    write(offset, length, value.toString(8).padStart(length - 1, "0"));
    header[offset + length - 1] = 0;
  };
  write(0, 100, entry.name);
  writeOctal(100, 8, 0o644);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  writeOctal(124, 12, entry.typeflag && entry.typeflag !== "0" ? 0 : body.length);
  writeOctal(136, 12, 0);
  header.fill(" ", 148, 156);
  write(156, 1, entry.typeflag ?? "0");
  write(157, 100, entry.linkname ?? "");
  write(257, 6, "ustar");
  write(263, 2, "00");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  write(148, 8, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 32;
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  writeFileSync(tarballPath, gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)])));
}

function createSyntheticMergeRepo(prefix: string): { dir: string; staleBase: string } {
  const dir = makeTempRepoRoot(tempDirs, prefix);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeRepoFile(dir, "README.md", "base\n");
  commitAll(dir, "base");
  const staleBase = git(dir, ["rev-parse", "HEAD"]);

  git(dir, ["switch", "-q", "-c", "feature"]);
  writeRepoFile(dir, "src/pr.ts", "export const pr = true;\n");
  commitAll(dir, "feature");

  git(dir, ["switch", "-q", "main"]);
  writeRepoFile(dir, "src/main-only.ts", "export const mainOnly = true;\n");
  commitAll(dir, "main only");
  git(dir, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "merge",
    "--no-ff",
    "feature",
    "-m",
    "synthetic merge",
  ]);

  return { dir, staleBase };
}

function classifyPackageJsonChange(
  prefix: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const dir = makeTempRepoRoot(tempDirs, prefix);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeRepoFile(dir, "package.json", prettyJson(before));
  commitAll(dir, "initial");
  writeRepoFile(dir, "package.json", prettyJson(after));

  const output = execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
    { cwd: dir, encoding: "utf8", env: createNestedGitEnv() },
  );
  return parseChangedLaneOutput(output);
}

afterEach(() => {
  cleanupCorepackPnpmShimDir();
  cleanupTempDirs(tempDirs);
});

describe("scripts/changed-lanes", () => {
  it("detects direct script execution from Windows argv paths", () => {
    expect(
      isDirectRunPath(
        "C:\\repo\\scripts\\check-changed.mjs",
        "c:\\repo\\scripts\\check-changed.mjs",
        "win32",
      ),
    ).toBe(true);
    expect(
      isDirectRunPath(
        "C:\\repo\\scripts\\changed-lanes.mjs",
        "C:\\repo\\scripts\\check-changed.mjs",
        "win32",
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "prints changed lane help without treating --help as a changed path",
      script: "scripts/changed-lanes.mjs",
      expected: {
        contains: "Usage: node scripts/changed-lanes.mjs",
        excludes: "--help: unknown surface",
      },
    },
    {
      name: "prints changed check help without running the changed gate",
      script: "scripts/check-changed.mjs",
      expected: { contains: "Usage: node scripts/check-changed.mjs", excludes: "[check:changed]" },
    },
  ])("$name", ({ script, expected }) => {
    const result = runRepoScript(script, ["--help"], {
      ...createNestedGitEnv(),
      OPENCLAW_TESTBOX: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(expected.contains);
    expect(result.stdout).not.toContain(expected.excludes);
  });

  it("exits cleanly for no changes without local dependencies", () => {
    const result = runRepoScript("scripts/check-changed.mjs", ["--no-changes"], {
      ...createNestedGitEnv(),
      PATH: "/nonexistent",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("[check:changed] no changed paths; nothing to run");
  });

  it("delegates when the local checkout cannot resolve the default base ref", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-missing-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeSuccessfulCrabboxNode(binDir);

    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/check-changed.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...createNestedGitEnv(),
        CI: "",
        GITHUB_ACTIONS: "",
        OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "",
        OPENCLAW_TESTBOX: "1",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("delegating through Crabbox workload routing");
    expect(result.stderr).not.toContain("ambiguous argument");
  });

  it("delegates path-scoped release metadata when local diff refs are unavailable", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-metadata-missing-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    writeRepoFile(dir, "node_modules/.modules.yaml", "layoutVersion: 5\n");
    writeRepoFile(dir, "node_modules/.bin/oxfmt", "#!/bin/sh\n");
    writeRepoFile(dir, "node_modules/typescript/package.json", '{"name":"typescript"}\n');
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeSuccessfulCrabboxNode(binDir);

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/check-changed.mjs"), "--", "CHANGELOG.md"],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...createNestedGitEnv(),
          CI: "",
          GITHUB_ACTIONS: "",
          OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "",
          OPENCLAW_TESTBOX: "",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("delegating through Crabbox workload routing");
  });

  it("persists delegated remote proof and forwards it to the next Testbox without a duplicate native child", () => {
    const repo = createProofRepo("changed-check-delegated-proof-lifecycle-");
    writeRepoFile(repo.dir, "src/core.ts", "export const core = 42;\n");
    commitAll(repo.dir, "core producer");

    const binDir = makeTempRepoRoot(tempDirs, "changed-check-fake-remote-bin-");
    mkdirSync(binDir, { recursive: true });
    writeFakeLifecycleCrabboxNode(binDir);
    const heavyCountPath = path.join(binDir, "remote-heavy-count.txt");
    const captureBundlePath = path.join(binDir, "second-prior-bundle.txt");
    const proofReceiptDir = makeTempRepoRoot(tempDirs, "changed-check-caller-receipts-");
    const env = {
      ...createNestedGitEnv(),
      CAPTURE_BUNDLE_PATH: captureBundlePath,
      CI: "",
      FAKE_BIN_DIR: binDir,
      FAKE_CRABBOX_RUNNER: path.join(binDir, "fake-crabbox-runner.mjs"),
      FAKE_TSGO_PROOF_WRITER: path.join(binDir, "fake-tsgo-proof-writer.mjs"),
      GITHUB_ACTIONS: "",
      HEAVY_COUNT_PATH: heavyCountPath,
      OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "",
      OPENCLAW_TESTBOX: "1",
      REAL_NODE: process.execPath,
      REPO_ROOT: repoRoot,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TSX_IMPORT: tsxImport,
    };
    const script = path.join(repoRoot, "scripts/check-changed.mjs");
    const args = ["--base", repo.base, "--head", "HEAD", "--proof-receipt-dir", proofReceiptDir];

    const first = spawnSync(process.execPath, [script, ...args], {
      cwd: repo.dir,
      encoding: "utf8",
      env,
    });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain("imported remote changed-check proof receipts: 1");
    expect(readFileSync(heavyCountPath, "utf8").trim()).toBe("1");
    expect(createCheckProofReceiptBundleFromDir(proofReceiptDir).receipts).toHaveLength(1);

    const second = spawnSync(process.execPath, [script, ...args], {
      cwd: repo.dir,
      encoding: "utf8",
      env,
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toContain("imported prior changed-check proof receipts: 1");
    expect(second.stderr).toContain("reusing changed-check evidence receipt");
    expect(readFileSync(heavyCountPath, "utf8").trim()).toBe("1");

    writeRepoFile(repo.dir, "src/descendant.ts", "export const descendant = 1;\n");
    commitAll(repo.dir, "affected descendant");
    const affected = spawnSync(process.execPath, [script, ...args], {
      cwd: repo.dir,
      encoding: "utf8",
      env,
    });
    expect(affected.status, affected.stderr).toBe(0);
    expect(affected.stderr).toContain("descendant changed-check plan includes typecheck core");
    expect(readFileSync(heavyCountPath, "utf8").trim()).toBe("2");
  });

  it.each([
    {
      name: "rejects unknown changed lane options before treating them as paths",
      script: "scripts/changed-lanes.mjs",
      option: "--jsno",
      expected: { stderr: "Unknown option: --jsno", excludes: [] },
    },
    {
      name: "rejects unknown changed check options before treating them as paths",
      script: "scripts/check-changed.mjs",
      option: "--dr-run",
      expected: {
        stderr: "Unknown option: --dr-run\n[check:changed] FAILED (exit 1)",
        excludes: [],
      },
    },
  ])("$name", ({ script, option, expected }) => {
    const result = runRepoScript(script, [option], {
      ...createNestedGitEnv(),
      OPENCLAW_TESTBOX: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(expected.stderr);
    expect(result.stderr).not.toContain("\n    at ");
    for (const excluded of expected.excludes) {
      expect(result.stderr).not.toContain(excluded);
    }
  });

  it("still accepts dash-prefixed explicit changed paths after the separator", () => {
    const result = runRepoScript("scripts/changed-lanes.mjs", ["--json", "--", "--github-output"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseChangedLaneOutput(result.stdout).paths).toEqual(["--github-output"]);
  });

  it("keeps changed check option-shaped paths intact after the separator", () => {
    const args = buildChangedCheckCrabboxArgs(["--staged", "--", "--no-changes"], {
      cwd: repoRoot,
    });

    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual([
      "--staged",
      "--",
      "--no-changes",
    ]);
  });

  it("prints changed check dry-run commands", () => {
    const result = runRepoScript("scripts/check-changed.mjs", [
      "--dry-run",
      "--",
      "extensions/lmstudio/src/api.ts",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[check:changed:dry-run] lanes=extensions, extensionTests");
    expect(result.stderr).toContain(
      "[check:changed:dry-run] would run: node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.extensions.json extensions/lmstudio/src/api.ts",
    );
  });

  it("prints changed-check evidence decisions in dry-run output", () => {
    const receiptDir = makeTempRepoRoot(tempDirs, "changed-check-dry-run-evidence-");
    const repo = createProofRepo("changed-check-dry-run-repo-");
    const runDryRun = (extraArgs: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(repoRoot, "scripts/check-changed.mjs"), ...extraArgs],
        {
          cwd: repo.dir,
          encoding: "utf8",
          env: createNestedGitEnv(),
        },
      );
    const freshResult = runDryRun([
      "--dry-run",
      "--no-reuse",
      "--proof-receipt-dir",
      receiptDir,
      "--base",
      repo.base,
      "--head",
      "HEAD",
      "--",
      "scripts/check-changed.mts",
    ]);
    expect(freshResult.status).toBe(0);
    expect(freshResult.stderr).toContain("[check:changed:dry-run] no reuse:");
    expect(freshResult.stderr).toContain("force-fresh requested");

    const missingResult = runDryRun([
      "--dry-run",
      "--proof-receipt-dir",
      receiptDir,
      "--base",
      repo.base,
      "--head",
      "HEAD",
      "--",
      "scripts/check-changed.mts",
    ]);
    expect(missingResult.status).toBe(0);
    expect(missingResult.stderr).toContain("missing changed-check evidence receipt");
  });

  it("includes untracked worktree files in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");

    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "new-check.mjs"), "export {};\n", "utf8");

    const result = runChangedLanesCli(dir, ["--json", "--base", "HEAD"]);

    expect(result.paths).toEqual(["scripts/new-check.mjs"]);
    expectLanes(result.lanes, { tooling: true });
  });

  it("falls back to a two-dot diff when a delegated checkout has no merge base", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-no-merge-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "--orphan", "feature"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "committed.ts"), "export const committed = 1;\n", "utf8");
    commitAll(dir, "feature base");
    writeFileSync(path.join(dir, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    expect(
      listChangedPathsFromGit({ base: "origin/main", cwd: dir, includeWorktree: false }),
    ).toEqual(["src/committed.ts"]);
    expect(listChangedPathsFromGit({ base: "origin/main", cwd: dir })).toEqual([
      "src/committed.ts",
      "src/feature.ts",
    ]);
  });

  it("prefers raw sync worktree paths over an implausibly broad no-merge-base diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-raw-sync-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    for (let index = 0; index < 250; index += 1) {
      writeFileSync(path.join(dir, `baseline-${index}.txt`), "baseline\n", "utf8");
    }
    commitAll(dir, "initial");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "--orphan", "feature"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "raw sync base",
    ]);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    const previousRawSync = process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
    delete process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
    try {
      const normalPaths = listChangedPathsFromGit({ base: "origin/main", cwd: dir });
      expect(normalPaths.length).toBeGreaterThan(200);
      expect(normalPaths).toContain("baseline-0.txt");
      expect(normalPaths).toContain("src/feature.ts");

      process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC = "1";
      expect(listChangedPathsFromGit({ base: "origin/main", cwd: dir })).toEqual([
        "src/feature.ts",
      ]);
    } finally {
      if (previousRawSync === undefined) {
        delete process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
      } else {
        process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC = previousRawSync;
      }
    }
  });

  it("includes committed and untracked added files in the changed format check", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-added-format-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeRepoFile(dir, "README.md", "initial\n");
    commitAll(dir, "initial");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "-c", "feature"]);
    writeRepoFile(dir, "src/committed.test.ts", "export const committed={value:1};\n");
    commitAll(dir, "add test");
    writeRepoFile(dir, "src/untracked.test.ts", "export const untracked={value:1};\n");
    writeRepoFile(dir, "--help", "ignored\n");

    const paths = listChangedPathsFromGit({ base: "origin/main", cwd: dir });
    const plan = createChangedCheckPlan(detectChangedLanes(paths));

    expect(paths).toEqual(["--help", "src/committed.test.ts", "src/untracked.test.ts"]);
    expect(plan.commands.find((command) => command.name === "format changed files")).toEqual({
      name: "format changed files",
      args: [
        "format:check",
        "--no-error-on-unmatched-pattern",
        "--",
        "--help",
        "src/committed.test.ts",
        "src/untracked.test.ts",
      ],
    });
  });

  it("includes staged added, modified, and deleted files in the changed format check", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-staged-format-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeRepoFile(dir, "src/modified.ts", "export const modified = { value: 1 };\n");
    writeRepoFile(dir, "src/removed.ts", "export const removed = { value: 1 };\n");
    commitAll(dir, "initial");
    writeRepoFile(dir, "src/added.test.ts", "export const added={value:1};\n");
    writeRepoFile(dir, "src/modified.ts", "export const modified={value:2};\n");
    git(dir, ["add", "src/added.test.ts", "src/modified.ts"]);
    git(dir, ["rm", "-q", "src/removed.ts"]);

    const paths = listStagedChangedPaths(dir);
    const plan = createChangedCheckPlan(detectChangedLanes(paths));

    expect(paths).toEqual(["src/added.test.ts", "src/modified.ts", "src/removed.ts"]);
    expect(plan.commands.find((command) => command.name === "format changed files")).toEqual({
      name: "format changed files",
      args: [
        "format:check",
        "--no-error-on-unmatched-pattern",
        "--",
        "src/added.test.ts",
        "src/modified.ts",
        "src/removed.ts",
      ],
    });
  });

  it("fails the changed format check on a misformatted added file and passes once formatted", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-format-added-");
    writeRepoFile(dir, "src/added.test.ts", "export const added={value:1};\n");

    const dirty = runChangedFormatLaneWithRepoOxfmt(dir, ["src/added.test.ts"]);
    expect(dirty.status).not.toBe(0);
    expect(`${dirty.stdout}${dirty.stderr}`).toContain("added.test.ts");

    writeRepoFile(dir, "src/added.test.ts", "export const added = { value: 1 };\n");
    const formatted = runChangedFormatLaneWithRepoOxfmt(dir, ["src/added.test.ts"]);
    expect(formatted.status).toBe(0);
  });

  it("fails the changed format check on a misformatted modified file", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-format-modified-");
    writeRepoFile(dir, "src/modified.ts", "export const modified={value:2};\n");

    const result = runChangedFormatLaneWithRepoOxfmt(dir, ["src/modified.ts"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("modified.ts");
  });

  it("does not fail the changed format check for deleted paths", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-format-deleted-");
    writeRepoFile(dir, "src/kept.ts", "export const kept = { value: 1 };\n");

    const result = runChangedFormatLaneWithRepoOxfmt(dir, ["src/deleted.ts", "src/kept.ts"]);
    expect(result.status).toBe(0);
  });

  it("uses the merge commit first parent instead of a stale PR payload base", () => {
    const { dir, staleBase } = createSyntheticMergeRepo("openclaw-changed-lanes-merge-");

    expect(listChangedPathsFromGit({ base: staleBase, cwd: dir, includeWorktree: false })).toEqual([
      "src/main-only.ts",
      "src/pr.ts",
    ]);
    expect(
      listChangedPathsFromGit({
        base: staleBase,
        cwd: dir,
        includeWorktree: false,
        mergeHeadFirstParent: true,
      }),
    ).toEqual(["src/pr.ts"]);
  });

  it("ignores local Crabbox metadata in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-crabbox-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, ".gitignore"), ".crabbox/\n", "utf8");
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");

    mkdirSync(path.join(dir, ".crabbox"), { recursive: true });
    writeFileSync(path.join(dir, ".crabbox", "capture-files.txt"), "stdout.log\n", "utf8");
    writeFileSync(path.join(dir, ".crabbox", "capture-manifest.txt"), "stdout.log\t12\n", "utf8");

    const result = runChangedLanesCli(dir, ["--json", "--base", "HEAD"]);

    expect(result.paths).toEqual([]);
    expectLanes(result.lanes, {});
  });

  it("includes deleted worktree files in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-deleted-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "shared", "obsolete.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    commitAll(dir, "initial");

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));

    const result = runChangedLanesCli(dir, ["--json", "--base", "HEAD"]);

    expect(result.paths).toEqual(["src/shared/obsolete.ts"]);
    expectLanes(result.lanes, { core: true, coreTests: true });
  });

  it("includes deleted staged files in the staged diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-staged-deleted-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "shared", "obsolete.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    commitAll(dir, "initial");

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));
    git(dir, ["add", "src/shared/obsolete.ts"]);

    const result = runChangedLanesCli(dir, ["--json", "--staged"]);

    expect(result.paths).toEqual(["src/shared/obsolete.ts"]);
    expectLanes(result.lanes, { core: true, coreTests: true });
  });

  it.each([
    { name: "core source", changedPaths: ["src/agents/api.ts"], expected: true },
    { name: "extension source", changedPaths: ["extensions/copilot/src/a.ts"], expected: true },
    { name: "ui source", changedPaths: ["ui/src/pages/a.ts"], expected: true },
    { name: "package source", changedPaths: ["packages/x/src/a.mts"], expected: true },
    // Matches the `[cm]?[jt]sx?` selector the lint lanes in check-changed.mts use.
    { name: "tsx source", changedPaths: ["ui/src/pages/Page.tsx"], expected: true },
    { name: "jsx source", changedPaths: ["ui/src/pages/Page.jsx"], expected: true },
    { name: "cjs source", changedPaths: ["src/agents/legacy.cjs"], expected: true },
    // An import-only edit can orphan a barrel re-export in a file this diff never
    // touches, so selection is by path; inspecting changed lines would miss it.
    { name: "import-only edit", changedPaths: ["src/agents/tool-surface-plan.ts"], expected: true },
    { name: "docs tree", changedPaths: ["docs/example.ts"], expected: false },
    { name: "scripts tree", changedPaths: ["scripts/check-changed.mjs"], expected: false },
    // knip never reads these, so they must not pull in the scan.
    { name: "markdown under src", changedPaths: ["src/README.md"], expected: false },
    { name: "sql under src", changedPaths: ["src/state/schema.sql"], expected: false },
  ])("selects the dead-export scan for $name", ({ changedPaths, expected }) => {
    expect(hasDeadcodeScannedSource(changedPaths)).toBe(expected);
  });

  it("ignores the explicit path separator", () => {
    const result = detectChangedLanes(["--", "scripts/test-live-acp-bind-docker.sh"]);

    expect(result.paths).toEqual(["scripts/test-live-acp-bind-docker.sh"]);
    expect(result.lanes.liveDockerTooling).toBe(true);
    expect(result.lanes.all).toBe(false);
  });

  it("routes a subagent-announce-only Docker diff through the live Docker lane", () => {
    const result = detectChangedLanes(["scripts/test-live-subagent-announce-docker.sh"]);

    expectLanes(result.lanes, { liveDockerTooling: true });
  });

  it.each([
    "extensions/whatsapp/src/config-ui-hints.ts",
    "extensions/mattermost/src/config-schema-core.ts",
    "extensions/telegram/openclaw.plugin.json",
    "extensions/discord/package.json",
    "extensions/slack/security-contract-api.ts",
    "src/config/zod-schema.core.ts",
    "src/channels/plugins/config-schema.ts",
    "scripts/load-channel-config-surface.ts",
  ])("routes %s through the bundled channel config metadata lane", (changedPath) => {
    const result = detectChangedLanes([changedPath]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.bundledChannelConfigMetadata).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain(
      "check:bundled-channel-config-metadata",
    );
  });

  it("keeps unrelated plugin runtime changes out of the bundled channel metadata lane", () => {
    const result = detectChangedLanes(["extensions/whatsapp/src/monitor.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.bundledChannelConfigMetadata).toBe(false);
    expect(plan.commands.map((command) => command.args[0])).not.toContain(
      "check:bundled-channel-config-metadata",
    );
  });

  it("includes bundled channel metadata in the fail-safe all plan", () => {
    const result = detectChangedLanes(["unknown-surface.foo"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.all).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain(
      "check:bundled-channel-config-metadata",
    );
  });

  it("exposes the shared changed-lane test path classifier", () => {
    expect(isChangedLaneTestPath("src/shared/string-normalization.test.ts")).toBe(true);
    expect(isChangedLaneTestPath("packages/foo/__tests__/helper.ts")).toBe(true);
    expect(isChangedLaneTestPath("src/example.ts")).toBe(false);
    expect(isChangedLaneTestPath("src/latest.ts")).toBe(false);
  });

  it("routes core production changes to core prod and core test lanes", () => {
    const result = detectChangedLanes(["packages/normalization-core/src/string-normalization.ts"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expectLanes(result.lanes, {
      core: true,
      coreTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain(
      "check:database-first-legacy-stores",
    );
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core:test");
    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
    });
    expect(plan.commands.find((command) => command.name === "lint core changed file")).toEqual({
      name: "lint core changed file",
      bin: "node",
      args: [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.core.json",
        "packages/normalization-core/src/string-normalization.ts",
      ],
      env: {
        PATH: "/usr/bin",
        OPENCLAW_OXLINT_SKIP_LOCK: "1",
        OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
        OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      },
    });
  });

  it("targets mixed core, extension, and script lint without full-owner fan-out", () => {
    const result = detectChangedLanes([
      "src/gateway/node-registry.ts",
      "extensions/lmstudio/src/models.fetch.ts",
      "scripts/check-changed.mjs",
    ]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lint core changed file",
          args: [
            "scripts/run-oxlint.mjs",
            "--tsconfig",
            "config/tsconfig/oxlint.core.json",
            "src/gateway/node-registry.ts",
          ],
        }),
        expect.objectContaining({
          name: "lint extension changed file",
          args: [
            "scripts/run-oxlint.mjs",
            "--tsconfig",
            "config/tsconfig/oxlint.extensions.json",
            "extensions/lmstudio/src/models.fetch.ts",
          ],
        }),
        expect.objectContaining({
          name: "lint script changed file",
          args: [
            "scripts/run-oxlint.mjs",
            "--tsconfig",
            "config/tsconfig/oxlint.scripts.json",
            "scripts/check-changed.mjs",
          ],
        }),
      ]),
    );
    const commandNames = plan.commands.map((command) => command.args[0]);
    for (const fullLane of ["lint:core", "lint:extensions", "lint:scripts"]) {
      expect(commandNames).not.toContain(fullLane);
    }
  });

  it.each([
    {
      owner: "core",
      paths: [
        "src/gateway/node-registry.ts",
        "src/gateway/node-registry.invoke-stream.ts",
        "src/gateway/server-methods/nodes.invoke.ts",
        "src/gateway/server-methods/nodes.invoke-deadline.ts",
        "src/node-host/runtime.ts",
        "src/node-host/runner.ts",
        "src/plugins/provider-self-hosted-setup.ts",
        "packages/gateway-client/src/timeouts.ts",
        "packages/normalization-core/src/number-coercion.ts",
      ],
      pluralName: "lint core changed files",
      singularName: "lint core changed file",
      fullLane: "lint:core",
    },
    {
      owner: "extension",
      paths: [
        "extensions/lmstudio/src/embedding-provider.ts",
        "extensions/lmstudio/src/stream.ts",
        "extensions/lmstudio/src/api.ts",
        "extensions/lmstudio/src/models.fetch.ts",
        "extensions/lmstudio/src/setup.ts",
        "extensions/lmstudio/src/defaults.ts",
        "extensions/lmstudio/src/provider-auth.ts",
        "extensions/lmstudio/src/runtime.ts",
        "extensions/lmstudio/src/models.ts",
      ],
      pluralName: "lint extension changed files",
      singularName: "lint extension changed file",
      fullLane: "lint:extensions",
    },
  ])("batches broad $owner changes without falling back to full lint", (testCase) => {
    const result = detectChangedLanes(testCase.paths);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
    const commands = plan.commands.filter(
      (command) => command.name === testCase.pluralName || command.name === testCase.singularName,
    );

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.args.slice(3).length)).toEqual([8, 1]);
    expect(commands.flatMap((command) => command.args.slice(3)).toSorted()).toEqual(
      testCase.paths.toSorted(),
    );
    expect(plan.commands.map((command) => command.args[0])).not.toContain(testCase.fullLane);
  });

  it.each([
    {
      name: "routes UI production changes to UI prod and core test lanes",
      path: "ui/src/app.ts",
      expected: {
        includes: ["tsgo:ui", "tsgo:core:test", "lint:ui:i18n"],
        excludes: ["tsgo:core"],
      },
    },
    {
      name: "routes the UI production config to UI prod and core test lanes",
      path: "tsconfig.ui.json",
      expected: { includes: ["tsgo:ui", "tsgo:core:test"], excludes: [] },
    },
  ])("$name", ({ path: changedPath, expected }) => {
    const result = detectChangedLanes([changedPath]);
    const commands = createChangedCheckPlan(result, {
      env: { PATH: "/usr/bin" },
    }).commands.map((command) => command.args[0]);

    expectLanes(result.lanes, { coreTests: true, ui: true });
    for (const command of expected.includes) {
      expect(commands).toContain(command);
    }
    for (const command of expected.excludes) {
      expect(commands).not.toContain(command);
    }
  });

  it.each(["scripts/control-ui-i18n.ts", "scripts/lib/example.ts", "tsconfig.scripts.json"])(
    "routes %s to the scripts typecheck lane",
    (changedPath) => {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result);

      expect(result.lanes.scripts).toBe(true);
      expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:scripts");
    },
  );

  it("keeps the scripts lane when another change selects the full lane", () => {
    const result = detectChangedLanes(["package.json", "scripts/example.mts"]);

    expect(result.lanes.all).toBe(true);
  });

  it("routes Control UI i18n tooling changes through keyless catalog verification", () => {
    const result = detectChangedLanes(["scripts/control-ui-i18n-verify.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunControlUiI18nVerify(result.paths)).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:ui:i18n");
    expect(shouldRunControlUiI18nVerify(["ui/config/control-ui-locales.ts"])).toBe(true);
    expect(shouldRunControlUiI18nVerify(["scripts/lib/example.ts"])).toBe(false);
  });

  it.each([
    ["test/vitest/foo.config.ts", true, true],
    ["test/vitest/vitest-runtime-helper.d.mts", true, true],
    ["test/fixtures/foo.ts", false, true],
    ["test/foo.mjs", false, true],
    ["test/tsconfig/tsconfig.test.root.json", true, true],
  ])(
    "routes %s to testRoot=%s and tooling=%s",
    (changedPath, expectedTestRoot, expectedTooling) => {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result);

      expect(result.lanes.testRoot).toBe(expectedTestRoot);
      expect(result.lanes.tooling).toBe(expectedTooling);
      expect(plan.commands.map((command) => command.args[0]).includes("tsgo:test:root")).toBe(
        expectedTestRoot,
      );
    },
  );

  it("falls back to full core lint for broad core diffs", () => {
    const targets = Array.from({ length: 9 }, (_, index) => `src/shared/file-${index}.ts`);
    const command = createTargetedCoreLintCommand(targets, { PATH: "/usr/bin" });

    expect(command).toBeNull();
  });

  it("falls back to full extension lint for broad extension diffs", () => {
    const targets = Array.from(
      { length: 9 },
      (_, index) => `extensions/discord/src/file-${index}.ts`,
    );
    const command = createTargetedExtensionLintCommand(targets, { PATH: "/usr/bin" });

    expect(command).toBeNull();
  });

  it("falls back to full core lint when a changed core target was deleted", () => {
    expect(
      createTargetedCoreLintCommand(
        ["src/shared/deleted.ts"],
        { PATH: "/usr/bin" },
        {
          fileExists: () => false,
        },
      ),
    ).toBeNull();
  });

  it("falls back to full core lint for mixed core lint configuration diffs", () => {
    expect(
      createTargetedCoreLintCommand(
        [
          "config/tsconfig/oxlint.core.json",
          "packages/normalization-core/src/string-normalization.ts",
        ],
        { PATH: "/usr/bin" },
        { fileExists: () => true },
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "targets small core lint diffs",
      create: createTargetedCoreLintCommand,
      targets: [
        ".github/workflows/ci.yml",
        "scripts/check-changed.mjs",
        "src/agents/auth-profiles/usage.ts",
        "test/scripts/changed-lanes.test.ts",
      ],
      expected: {
        name: "lint core changed file",
        tsconfig: "config/tsconfig/oxlint.core.json",
        path: "src/agents/auth-profiles/usage.ts",
      },
    },
    {
      name: "targets small extension lint diffs",
      create: createTargetedExtensionLintCommand,
      targets: ["extensions/lmstudio/src/api.ts", "docs/help/testing.md"],
      expected: {
        name: "lint extension changed file",
        tsconfig: "config/tsconfig/oxlint.extensions.json",
        path: "extensions/lmstudio/src/api.ts",
      },
    },
    {
      name: "targets small script lint diffs",
      create: createTargetedScriptLintCommand,
      targets: ["scripts/check-changed.mjs", "test/scripts/changed-lanes.test.ts"],
      expected: {
        name: "lint script changed file",
        tsconfig: "config/tsconfig/oxlint.scripts.json",
        path: "scripts/check-changed.mjs",
      },
    },
  ])("$name", ({ create, targets, expected }) => {
    expect(create(targets, { PATH: "/usr/bin" }, { fileExists: () => true })).toEqual({
      name: expected.name,
      bin: "node",
      args: ["scripts/run-oxlint.mjs", "--tsconfig", expected.tsconfig, expected.path],
      env: { PATH: "/usr/bin" },
    });
  });

  it("reenables local-check policy for changed typecheck commands", () => {
    const result = detectChangedLanes(["packages/normalization-core/src/string-normalization.ts"]);
    const plan = createChangedCheckPlan(result, {
      env: { OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" },
    });

    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
      PATH: "/usr/bin",
    });
  });

  it("marks changed-check children as covered by the parent heavy-check lock", () => {
    expect(createChangedCheckChildEnv({ PATH: "/usr/bin" })).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it("runs CI changed-check children through Corepack pnpm", () => {
    const command = createPnpmManagedCommand(
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { CI: "1", PATH: "/usr/bin" },
    );

    expect(command.bin).toBe("corepack");
    expect(command.args).toEqual(["pnpm", "check:no-conflict-markers"]);
  });

  it("reuses only exact passed proof receipts for the same command family", () => {
    const receiptDir = makeTempRepoRoot(tempDirs, "changed-check-evidence-");
    const fixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 100;\n",
      producerPath: "src/core.ts",
    });
    const expected = createExpectedProof({
      currentPaths: ["src/core.ts"],
      fixture,
    });
    const stored = fixture.receipt;

    expect(stored.requiredInputs.repo).not.toHaveProperty("worktreeRoot");
    expect(stored.producer.worktreeRoot).toBe(fixture.dir);
    expect(isReusableCheckProofReceipt(stored, expected)).toBe(true);
    writeCheckProofReceipt(receiptDir, stored);
    expect(evaluateReusableReceipt(receiptDir, expected)).toEqual(
      expect.objectContaining({
        reusable: true,
        reason: "exact-target evidence reuse",
      }),
    );
    expect(
      isReusableCheckProofReceipt(
        {
          ...stored,
          commandFamily: "tsgolint",
        },
        expected,
      ),
    ).toBe(false);
    expect(
      isReusableCheckProofReceipt(
        {
          ...stored,
          status: "skipped",
          ranTool: false,
        },
        expected,
      ),
    ).toBe(false);
  });

  it("fails exact-target proof reuse on dirty or untracked worktree state outside changed paths", () => {
    const untracked = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 101;\n",
      producerPath: "src/core.ts",
    });
    const untrackedExpected = createExpectedProof({
      currentPaths: ["src/core.ts"],
      fixture: untracked,
    });
    writeRepoFile(untracked.dir, "docs/outside-current-paths.md", "dirty\n");
    expect(evaluateReusableReceipt(untracked.receiptDir, untrackedExpected)).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "current worktree has dirty or untracked files",
      }),
    );

    const tracked = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 102;\n",
      producerPath: "src/core.ts",
    });
    const trackedExpected = createExpectedProof({
      currentPaths: ["src/core.ts"],
      fixture: tracked,
    });
    writeRepoFile(tracked.dir, "package.json", `${prettyJson({ name: "proof-repo-dirty" })}`);
    expect(evaluateReusableReceipt(tracked.receiptDir, trackedExpected)).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "current worktree has dirty or untracked files",
      }),
    );

    const artifact = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 103;\n",
      producerPath: "src/core.ts",
    });
    const artifactReceiptDir = path.join(artifact.dir, ".artifacts/check-changed-receipts");
    writeCheckProofReceipt(artifactReceiptDir, artifact.receipt);
    expect(
      evaluateReusableReceipt(
        artifactReceiptDir,
        createExpectedProof({ currentPaths: ["src/core.ts"], fixture: artifact }),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: true,
        reason: "exact-target evidence reuse",
      }),
    );
  });

  it("round-trips bounded remote proof bundles without letting failed writes overwrite PASS", () => {
    const fixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 21;\n",
      producerPath: "src/core.ts",
    });
    const encoded = expectDefined(
      encodeCheckProofReceiptBundleForEnv(fixture.receiptDir),
      "encoded receipt bundle",
    );
    const decoded = decodeCheckProofReceiptBundleFromEnv(encoded);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      throw new Error(decoded.reason);
    }
    expect(decoded.bundle.receipts).toHaveLength(1);

    const importedDir = makeTempRepoRoot(tempDirs, "changed-check-imported-evidence-");
    expect(importCheckProofReceiptBundle(importedDir, decoded.bundle)).toEqual(
      expect.objectContaining({ imported: 1 }),
    );
    const expected = createExpectedProof({
      currentPaths: ["src/core.ts"],
      fixture,
    });
    expect(evaluateReusableReceipt(importedDir, expected)).toEqual(
      expect.objectContaining({
        reusable: true,
        reason: "exact-target evidence reuse",
      }),
    );

    const skipped = cloneJson(fixture.receipt);
    skipped.status = "skipped";
    skipped.ranTool = false;
    writeCheckProofReceipt(importedDir, skipped);
    const failed = cloneJson(fixture.receipt);
    failed.status = "failed";
    failed.exitCode = 1;
    writeCheckProofReceipt(importedDir, failed);

    expect(
      JSON.parse(
        readFileSync(path.join(importedDir, `${fixture.receipt.fingerprint}.json`), "utf8"),
      ),
    ).toEqual(expect.objectContaining({ status: "passed", ranTool: true }));
    expect(createCheckProofReceiptBundleFromDir(importedDir).receipts).toHaveLength(1);
    expect(evaluateReusableReceipt(importedDir, expected)).toEqual(
      expect.objectContaining({ reusable: true }),
    );
  });

  it("fails closed for concurrent or stale receipt-store locks without clobbering PASS", () => {
    const fixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 211;\n",
      producerPath: "src/core.ts",
    });
    const lockedDir = makeTempRepoRoot(tempDirs, "changed-check-locked-receipts-");
    writeFileSync(path.join(lockedDir, ".install.lock"), "stale\n", "utf8");

    expect(writeCheckProofReceipt(lockedDir, fixture.receipt)).toEqual({
      installed: false,
      reason: "receipt store busy",
    });
    expect(existsSync(path.join(lockedDir, `${fixture.receipt.fingerprint}.json`))).toBe(false);

    unlinkSync(path.join(lockedDir, ".install.lock"));
    expect(writeCheckProofReceipt(lockedDir, fixture.receipt)).toEqual({
      installed: true,
      reason: "installed reusable receipt",
    });
    writeFileSync(path.join(lockedDir, ".install.lock"), "concurrent\n", "utf8");
    expect(writeCheckProofReceipt(lockedDir, cloneJson(fixture.receipt))).toEqual({
      installed: false,
      reason: "receipt store busy",
    });
    expect(
      JSON.parse(readFileSync(path.join(lockedDir, `${fixture.receipt.fingerprint}.json`), "utf8")),
    ).toEqual(expect.objectContaining({ status: "passed", ranTool: true }));
  });

  it("fails closed for malformed remote bundles and unsafe Crabbox artifact archives", () => {
    const fixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 22;\n",
      producerPath: "src/core.ts",
    });
    const bundle = createCheckProofReceiptBundleFromDir(fixture.receiptDir);
    const bundleJson = prettyJson(bundle);
    const exportPath = ".artifacts/check-changed-proof-export/testnonce.json";
    const artifactRoot = makeTempRepoRoot(tempDirs, "changed-check-proof-artifact-");
    mkdirSync(path.join(artifactRoot, path.dirname(exportPath)), { recursive: true });
    writeFileSync(path.join(artifactRoot, exportPath), bundleJson, "utf8");
    const tarballPath = path.join(artifactRoot, "proof.tgz");
    execFileSync("tar", ["-czf", tarballPath, exportPath], { cwd: artifactRoot });

    expect(readCheckProofReceiptBundleFromArtifactTarball(tarballPath, exportPath)).toEqual(
      expect.objectContaining({ receipts: [fixture.receipt] }),
    );

    const badDigest = { ...bundle, digest: "0".repeat(64) };
    const badEncoded = Buffer.from(prettyJson(badDigest), "utf8").toString("base64");
    expect(decodeCheckProofReceiptBundleFromEnv(badEncoded)).toEqual(
      expect.objectContaining({ ok: false, reason: "changed-check proof bundle digest mismatch" }),
    );
    expect(decodeCheckProofReceiptBundleFromEnv("not-base64")).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(
      decodeCheckProofReceiptBundleFromEnv(
        Buffer.from("x".repeat(70 * 1024), "utf8").toString("base64"),
      ),
    ).toEqual(expect.objectContaining({ ok: false }));

    const extraRoot = makeTempRepoRoot(tempDirs, "changed-check-proof-extra-");
    mkdirSync(path.join(extraRoot, path.dirname(exportPath)), { recursive: true });
    writeFileSync(path.join(extraRoot, exportPath), bundleJson, "utf8");
    writeFileSync(path.join(extraRoot, "extra.json"), "{}\n", "utf8");
    const extraTarball = path.join(extraRoot, "extra.tgz");
    execFileSync("tar", ["-czf", extraTarball, exportPath, "extra.json"], { cwd: extraRoot });
    expect(() => readCheckProofReceiptBundleFromArtifactTarball(extraTarball, exportPath)).toThrow(
      /member mismatch/u,
    );

    const symlinkRoot = makeTempRepoRoot(tempDirs, "changed-check-proof-symlink-");
    mkdirSync(path.join(symlinkRoot, path.dirname(exportPath)), { recursive: true });
    writeFileSync(path.join(symlinkRoot, "real.json"), bundleJson, "utf8");
    symlinkSync("../../real.json", path.join(symlinkRoot, exportPath));
    const symlinkTarball = path.join(symlinkRoot, "symlink.tgz");
    execFileSync("tar", ["-czf", symlinkTarball, exportPath], { cwd: symlinkRoot });
    expect(() =>
      readCheckProofReceiptBundleFromArtifactTarball(symlinkTarball, exportPath),
    ).toThrow(/regular file/u);

    const hardlinkTarball = path.join(artifactRoot, "hardlink.tgz");
    writeSingleEntryTarGz(hardlinkTarball, {
      name: exportPath,
      typeflag: "1",
      linkname: "real.json",
    });
    expect(() =>
      readCheckProofReceiptBundleFromArtifactTarball(hardlinkTarball, exportPath),
    ).toThrow(/regular file/u);

    const fifoTarball = path.join(artifactRoot, "fifo.tgz");
    writeSingleEntryTarGz(fifoTarball, { name: exportPath, typeflag: "6" });
    expect(() => readCheckProofReceiptBundleFromArtifactTarball(fifoTarball, exportPath)).toThrow(
      /regular file/u,
    );

    const oversizedTarball = path.join(artifactRoot, "oversized.tgz");
    writeFileSync(oversizedTarball, Buffer.alloc(1024 * 1024 + 1));
    expect(() =>
      readCheckProofReceiptBundleFromArtifactTarball(oversizedTarball, exportPath),
    ).toThrow(/missing or oversized/u);
  });

  it("resolves the exact Blacksmith artifact tarball from final timing JSON", () => {
    const root = makeTempRepoRoot(tempDirs, "changed-check-proof-timing-");
    const preserved = path.join(root, ".crabbox", "runs", "tbx_test", "blacksmith-artifacts.tgz");
    mkdirSync(path.dirname(preserved), { recursive: true });
    writeFileSync(preserved, "tarball\n", "utf8");
    const timing = JSON.stringify({
      provider: "blacksmith-testbox",
      leaseId: "tbx_test",
      exitCode: 0,
      artifacts: [
        {
          kind: "artifact-glob",
          path: "/tmp/openclaw-crabbox-sync/.crabbox/runs/tbx_test/blacksmith-artifacts.tgz",
        },
      ],
    });

    expect(resolveChangedCheckProofArtifactPath(`noise\n${timing}\n`, root)).toBe(preserved);
    const arbitrary = path.join(root, "blacksmith-artifacts.tgz");
    writeFileSync(arbitrary, "tarball\n", "utf8");
    expect(() =>
      resolveChangedCheckProofArtifactPath(
        JSON.stringify({
          provider: "blacksmith-testbox",
          leaseId: "tbx_test",
          exitCode: 0,
          artifacts: [{ kind: "artifact-glob", path: arbitrary }],
        }),
        root,
      ),
    ).toThrow(/does not match lease-local/u);
    expect(() =>
      resolveChangedCheckProofArtifactPath(
        JSON.stringify({
          provider: "blacksmith-testbox",
          leaseId: "tbx_test",
          exitCode: 0,
          artifacts: [],
        }),
        root,
      ),
    ).toThrow(/did not report an artifact-glob/u);
    expect(() =>
      resolveChangedCheckProofArtifactPath(
        JSON.stringify({
          provider: "blacksmith-testbox",
          leaseId: "tbx_test",
          exitCode: 1,
          artifacts: [{ kind: "artifact-glob", path: preserved }],
        }),
        root,
      ),
    ).toThrow(/did not report success/u);
  });

  it("continues descendant receipt scans after stale or malformed earlier candidates", () => {
    const fixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 201;\n",
      producerPath: "src/core.ts",
    });
    writeRepoFile(fixture.dir, "docs/current.md", "current\n");
    commitAll(fixture.dir, "current descendant");
    const expected = createExpectedProof({
      currentPaths: ["docs/current.md", "src/core.ts"],
      fixture,
    });
    const stale = cloneJson(fixture.receipt);
    stale.requiredInputs.git.currentHead = "f".repeat(40);
    writeFileSync(path.join(fixture.receiptDir, `${"0".repeat(64)}.json`), prettyJson(stale));
    writeFileSync(path.join(fixture.receiptDir, `${"1".repeat(64)}.json`), "{", "utf8");

    expect(
      evaluateReusableReceipt(
        fixture.receiptDir,
        expected,
        createDescendantOptionsForTest(fixture.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: true,
        reason: "descendant-safe evidence reuse",
        path: path.join(fixture.receiptDir, `${fixture.receipt.fingerprint}.json`),
      }),
    );

    const overLimitDir = makeTempRepoRoot(tempDirs, "changed-check-overlimit-receipts-");
    for (let index = 0; index < 513; index += 1) {
      writeFileSync(path.join(overLimitDir, `${index.toString(16).padStart(64, "0")}.json`), "{}");
    }
    expect(
      evaluateReusableReceipt(overLimitDir, expected, createDescendantOptionsForTest(fixture.dir)),
    ).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "too many changed-check evidence receipts to scan",
      }),
    );
  });

  it("reuses ancestor proof when descendant commits are docs-only or release metadata only", () => {
    const docsFixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 2;\n",
      producerPath: "src/core.ts",
    });
    writeRepoFile(docsFixture.dir, "docs/release-notes.md", "docs descendant\n");
    commitAll(docsFixture.dir, "docs descendant");
    const docsHead = git(docsFixture.dir, ["rev-parse", "HEAD"]);
    const docsDeltaPlan = createDescendantPlanForTest(docsFixture.dir, {
      currentHead: docsHead,
      paths: ["docs/release-notes.md"],
      producerHead: docsFixture.producerHead,
    });
    expect(docsDeltaPlan.commands.filter((command) => commandFamily(command) !== "other")).toEqual(
      [],
    );
    const docsExpected = createExpectedProof({
      currentPaths: ["docs/release-notes.md", "src/core.ts"],
      fixture: docsFixture,
    });
    expect(
      evaluateReusableReceipt(
        docsFixture.receiptDir,
        docsExpected,
        createDescendantOptionsForTest(docsFixture.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: true,
        reason: "descendant-safe evidence reuse",
      }),
    );

    const releaseFixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 3;\n",
      producerPath: "src/core.ts",
    });
    writeRepoFile(
      releaseFixture.dir,
      "package.json",
      prettyJson({ name: "proof-repo", version: "0.0.1", scripts: {} }),
    );
    commitAll(releaseFixture.dir, "release metadata descendant");
    const releaseExpected = createExpectedProof({
      currentPaths: ["package.json", "src/core.ts"],
      fixture: releaseFixture,
    });
    expect(
      evaluateReusableReceipt(
        releaseFixture.receiptDir,
        releaseExpected,
        createDescendantOptionsForTest(releaseFixture.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: true,
        reason: "descendant-safe evidence reuse",
      }),
    );
  });

  it("maps descendant lanes to affected proof commands", () => {
    const unaffectedFixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 4;\n",
      producerPath: "src/core.ts",
    });
    writeRepoFile(
      unaffectedFixture.dir,
      "extensions/demo/src/index.ts",
      "export const extension = 1;\n",
    );
    commitAll(unaffectedFixture.dir, "extension descendant");
    const unaffectedExpected = createExpectedProof({
      currentPaths: ["extensions/demo/src/index.ts", "src/core.ts"],
      fixture: unaffectedFixture,
    });
    expect(
      evaluateReusableReceipt(
        unaffectedFixture.receiptDir,
        unaffectedExpected,
        createDescendantOptionsForTest(unaffectedFixture.dir),
      ),
    ).toEqual(expect.objectContaining({ reusable: true }));

    const affectedFixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 5;\n",
      producerPath: "src/core.ts",
    });
    writeRepoFile(affectedFixture.dir, "src/descendant.ts", "export const descendant = 1;\n");
    commitAll(affectedFixture.dir, "core descendant");
    const affectedExpected = createExpectedProof({
      currentPaths: ["src/core.ts", "src/descendant.ts"],
      fixture: affectedFixture,
    });
    expect(
      evaluateReusableReceipt(
        affectedFixture.receiptDir,
        affectedExpected,
        createDescendantOptionsForTest(affectedFixture.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "descendant changed-check plan includes typecheck core",
      }),
    );
  });

  it("invalidates core and extension proof for descendant public contract changes", () => {
    for (const [commandName, producerPath] of [
      ["typecheck core", "src/core.ts"],
      ["typecheck extensions", "extensions/demo/src/index.ts"],
    ] as const) {
      const fixture = createStoredProof({
        commandName,
        producerContents: `export const value = ${JSON.stringify(commandName)};\n`,
        producerPath,
      });
      writeRepoFile(
        fixture.dir,
        "src/plugin-sdk/descendant-contract.ts",
        "export const api = 2;\n",
      );
      commitAll(fixture.dir, "public contract descendant");
      const expected = createExpectedProof({
        currentPaths: [producerPath, "src/plugin-sdk/descendant-contract.ts"],
        fixture,
      });
      expect(
        evaluateReusableReceipt(
          fixture.receiptDir,
          expected,
          createDescendantOptionsForTest(fixture.dir),
        ),
        commandName,
      ).toEqual(expect.objectContaining({ reusable: false }));
    }
  });

  it("fails closed for global, owner-input, ancestry, dirty, and skipped descendant candidates", () => {
    const globalCases = [
      ["unknown root path", "mystery.root", "descendant changed-check delta requires full proof"],
      ["lockfile", "pnpm-lock.yaml", "descendant changed-check delta requires full proof"],
      [
        "planner input",
        "scripts/lib/check-proof-reuse.mts",
        "changed-check evidence owner input changed: scripts/lib/check-proof-reuse.mts",
      ],
      [
        "wrapper input",
        "scripts/run-tsgo.mts",
        "changed-check evidence receipt lacks matching native wrapper proof",
      ],
      [
        "config closure",
        "tsconfig.core.json",
        "changed-check evidence receipt lacks matching native wrapper proof",
      ],
    ] as const;
    for (const [name, descendantPath, reason] of globalCases) {
      const fixture = createStoredProof({
        commandName: "typecheck core",
        producerContents: `export const core = ${JSON.stringify(name)};\n`,
        producerPath: "src/core.ts",
      });
      writeRepoFile(fixture.dir, descendantPath, `${name}\n`);
      commitAll(fixture.dir, `${name} descendant`);
      const expected = createExpectedProof({
        currentPaths: ["src/core.ts", descendantPath],
        fixture,
      });
      if (descendantPath === "scripts/lib/check-proof-reuse.mts") {
        expected.requiredInputs.invalidationInputs[descendantPath] = "changed";
      } else if (descendantPath === "scripts/run-tsgo.mts") {
        expect(expected.requiredInputs.expectedWrapperProof).not.toBeNull();
        if (expected.requiredInputs.expectedWrapperProof) {
          expected.requiredInputs.expectedWrapperProof.wrapperDigest = "changed";
        }
      } else if (descendantPath === "tsconfig.core.json") {
        expect(expected.requiredInputs.expectedWrapperProof).not.toBeNull();
        if (expected.requiredInputs.expectedWrapperProof) {
          expected.requiredInputs.expectedWrapperProof.configDigests["tsconfig.core.json"] =
            "changed";
        }
      }
      expect(
        evaluateReusableReceipt(
          fixture.receiptDir,
          expected,
          createDescendantOptionsForTest(fixture.dir),
        ),
        name,
      ).toEqual(expect.objectContaining({ reusable: false, reason }));
    }

    const nonAncestor = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 6;\n",
      producerPath: "src/core.ts",
    });
    git(nonAncestor.dir, ["switch", "-q", "-c", "side", nonAncestor.base]);
    writeRepoFile(nonAncestor.dir, "docs/side.md", "side\n");
    commitAll(nonAncestor.dir, "side");
    const sideHead = git(nonAncestor.dir, ["rev-parse", "HEAD"]);
    git(nonAncestor.dir, ["switch", "-q", "main"]);
    const nonAncestorReceipt = cloneJson(nonAncestor.receipt);
    nonAncestorReceipt.requiredInputs.git.currentHead = sideHead;
    writeFileSync(
      path.join(nonAncestor.receiptDir, `${nonAncestorReceipt.fingerprint}.json`),
      prettyJson(nonAncestorReceipt),
      "utf8",
    );
    writeRepoFile(nonAncestor.dir, "docs/current.md", "current\n");
    commitAll(nonAncestor.dir, "current descendant");
    expect(
      evaluateReusableReceipt(
        nonAncestor.receiptDir,
        createExpectedProof({
          currentPaths: ["docs/current.md", "src/core.ts"],
          fixture: nonAncestor,
        }),
        createDescendantOptionsForTest(nonAncestor.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "changed-check evidence producer is not an ancestor of current HEAD",
      }),
    );

    const unresolved = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 7;\n",
      producerPath: "src/core.ts",
    });
    const unresolvedReceipt = cloneJson(unresolved.receipt);
    unresolvedReceipt.requiredInputs.git.currentHead = "f".repeat(40);
    writeFileSync(
      path.join(unresolved.receiptDir, `${unresolvedReceipt.fingerprint}.json`),
      prettyJson(unresolvedReceipt),
      "utf8",
    );
    writeRepoFile(unresolved.dir, "docs/current.md", "current\n");
    commitAll(unresolved.dir, "current descendant");
    expect(
      evaluateReusableReceipt(
        unresolved.receiptDir,
        createExpectedProof({
          currentPaths: ["docs/current.md", "src/core.ts"],
          fixture: unresolved,
        }),
        createDescendantOptionsForTest(unresolved.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "changed-check evidence ancestry unresolved",
      }),
    );

    const dirty = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 8;\n",
      producerPath: "src/core.ts",
    });
    writeRepoFile(dirty.dir, "docs/current.md", "current\n");
    commitAll(dirty.dir, "current descendant");
    const dirtyExpected = createExpectedProof({
      currentPaths: ["docs/current.md", "src/core.ts"],
      fixture: dirty,
    });
    writeRepoFile(dirty.dir, "docs/uncommitted.md", "dirty\n");
    expect(
      evaluateReusableReceipt(
        dirty.receiptDir,
        dirtyExpected,
        createDescendantOptionsForTest(dirty.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "current worktree has dirty or untracked files",
      }),
    );

    const skipped = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 9;\n",
      producerPath: "src/core.ts",
    });
    const skippedReceipt = cloneJson(skipped.receipt);
    skippedReceipt.status = "skipped";
    skippedReceipt.ranTool = false;
    writeFileSync(
      path.join(skipped.receiptDir, `${skippedReceipt.fingerprint}.json`),
      prettyJson(skippedReceipt),
      "utf8",
    );
    writeRepoFile(skipped.dir, "docs/current.md", "current\n");
    commitAll(skipped.dir, "current descendant");
    expect(
      evaluateReusableReceipt(
        skipped.receiptDir,
        createExpectedProof({
          currentPaths: ["docs/current.md", "src/core.ts"],
          fixture: skipped,
        }),
        createDescendantOptionsForTest(skipped.dir),
      ),
    ).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "changed-check evidence receipt did not pass with ranTool=true",
      }),
    );
  });

  it("never uses tsgo ancestor receipts as tsgolint proof", () => {
    const fixture = createStoredProof({
      commandName: "typecheck scripts",
      producerContents: "export const script = 1;\n",
      producerPath: "scripts/tool.mts",
    });
    writeRepoFile(fixture.dir, "docs/current.md", "current\n");
    commitAll(fixture.dir, "current descendant");
    const tsgolintCommand = {
      name: "lint scripts changed file",
      bin: "node",
      args: [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.scripts.json",
        "scripts/tool.mts",
      ],
      env: { PATH: "/usr/bin" },
    };
    const tsgolintProof = createWrapperProof({
      tool: "tsgolint",
      wrapper: "scripts/run-oxlint.mts",
      argv: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts/tool.mts"],
      cwd: fixture.dir,
    });
    const expectedTsgolint = createCheckProofReceipt({
      command: tsgolintCommand,
      context: {
        base: fixture.base,
        changedPaths: ["docs/current.md", "scripts/tool.mts"],
        cwd: fixture.dir,
        head: git(fixture.dir, ["rev-parse", "HEAD"]),
        planSummary: "scripts, docs",
      },
      exitCode: 0,
      expectedWrapperProof: tsgolintProof,
      wrapperProof: tsgolintProof,
    });

    expect(
      evaluateReusableReceipt(
        fixture.receiptDir,
        expectedTsgolint,
        createDescendantOptionsForTest(fixture.dir),
      ),
    ).toEqual(expect.objectContaining({ reusable: false }));
  });

  it("invalidates changed-check evidence receipts on owner facts", () => {
    const command = {
      name: "typecheck scripts",
      bin: "node",
      args: ["scripts/run-tsgo.mjs", "-p", "scripts/tsconfig.json", "--noEmit"],
      env: { PATH: "/usr/bin", OPENCLAW_LOCAL_CHECK: "1" },
    };
    const context = {
      base: "origin/main",
      head: "HEAD",
      changedPaths: ["scripts/check-changed.mts"],
      planSummary: "scripts",
      planCommands: [command],
      cwd: repoRoot,
    };
    const wrapperProof = createWrapperProof({
      tool: "tsgo",
      wrapper: "scripts/run-tsgo.mts",
      argv: ["-p", "scripts/tsconfig.json", "--noEmit"],
      cwd: repoRoot,
    });
    const expected = createCheckProofReceipt({
      command,
      context,
      exitCode: 0,
      expectedWrapperProof: wrapperProof,
      wrapperProof,
    });

    const cases: Array<[string, (receipt: CheckProofReceipt) => void]> = [
      [
        "repo identity",
        (receipt) => {
          receipt.requiredInputs.repo.remoteOrigin = "https://example.invalid/openclaw.git";
        },
      ],
      [
        "head/tree",
        (receipt) => {
          receipt.requiredInputs.git.currentHead = "0".repeat(40);
          receipt.requiredInputs.git.currentTree = "1".repeat(40);
        },
      ],
      [
        "base and merge-base",
        (receipt) => {
          receipt.requiredInputs.git.baseSha = "2".repeat(40);
          receipt.requiredInputs.git.mergeBaseSha = "3".repeat(40);
        },
      ],
      [
        "changed paths",
        (receipt) => {
          receipt.requiredInputs.changedPaths.paths = ["scripts/changed-lanes.mts"];
        },
      ],
      [
        "dirty or untracked relevant input state",
        (receipt) => {
          receipt.requiredInputs.changedPaths.states["scripts/check-changed.mts"] = {
            kind: "file",
            digest: "dirty",
          };
        },
      ],
      [
        "lane plan and commands",
        (receipt) => {
          receipt.requiredInputs.plan.summary = "all";
          receipt.requiredInputs.plan.commands[0]?.args.push("--pretty");
        },
      ],
      [
        "effective command argv",
        (receipt) => {
          receipt.requiredInputs.command.args = [
            "scripts/run-tsgo.mjs",
            "-p",
            "tsconfig.core.json",
          ];
        },
      ],
      [
        "effective environment",
        (receipt) => {
          receipt.requiredInputs.env.OPENCLAW_LOCAL_CHECK_MODE = "ci";
        },
      ],
      [
        "wrapper/helper/config/package/lock/toolchain inputs",
        (receipt) => {
          receipt.requiredInputs.invalidationInputs["scripts/check-changed.mts"] = "changed";
          receipt.requiredInputs.invalidationInputs["package.json"] = "changed";
          receipt.requiredInputs.invalidationInputs["pnpm-lock.yaml"] = "changed";
        },
      ],
      [
        "runtime and platform",
        (receipt) => {
          receipt.requiredInputs.runtime.node = "v0.0.0";
          receipt.requiredInputs.runtime.platform = "linux";
        },
      ],
      [
        "wrapper identity and config closure",
        (receipt) => {
          const proof = receipt.requiredInputs.expectedWrapperProof;
          expect(proof).not.toBeNull();
          if (proof) {
            proof.wrapperDigest = "changed";
            proof.configDigests["scripts/tsconfig.json"] = "changed";
          }
        },
      ],
    ];

    for (const [name, mutate] of cases) {
      const stored = cloneJson(expected);
      mutate(stored);
      expect(isReusableCheckProofReceipt(stored, expected), name).toBe(false);
    }
  });

  it("rejects malformed, partial, and old-schema changed-check evidence receipts", () => {
    const receiptDir = makeTempRepoRoot(tempDirs, "changed-check-bad-evidence-");
    const fixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 301;\n",
      producerPath: "src/core.ts",
    });
    const expected = createExpectedProof({
      currentPaths: ["src/core.ts"],
      fixture,
    });
    const receiptPath = path.join(receiptDir, `${expected.fingerprint}.json`);

    writeFileSync(`${receiptPath}.tmp`, prettyJson(expected), "utf8");
    expect(evaluateReusableReceipt(receiptDir, expected)).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "missing changed-check evidence receipt",
      }),
    );

    writeFileSync(receiptPath, "{", "utf8");
    expect(evaluateReusableReceipt(receiptDir, expected)).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "malformed changed-check evidence receipt",
      }),
    );

    writeFileSync(
      receiptPath,
      prettyJson({ ...expected, schemaVersion: 1, artifact: "changed-check evidence receipt" }),
      "utf8",
    );
    expect(evaluateReusableReceipt(receiptDir, expected)).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "current-schema changed-check evidence receipt not found",
      }),
    );

    writeFileSync(receiptPath, prettyJson({ ...expected, status: "skipped", ranTool: false }));
    expect(evaluateReusableReceipt(receiptDir, expected)).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "changed-check evidence receipt did not pass with ranTool=true",
      }),
    );
  });

  it("keeps tsgo evidence separate from tsgolint evidence", () => {
    const receiptDir = makeTempRepoRoot(tempDirs, "changed-check-family-");
    const repo = createProofRepo("changed-check-family-repo-");
    const context = {
      base: repo.base,
      head: "HEAD",
      changedPaths: ["scripts/check-changed.mts"],
      planSummary: "scripts",
      cwd: repo.dir,
    };
    const tsgolintCommand = {
      name: "lint scripts changed file",
      bin: "node",
      args: [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.scripts.json",
        "scripts/check-changed.mts",
      ],
      env: { PATH: "/usr/bin" },
    };
    const tsgolintProof = createWrapperProof({
      tool: "tsgolint",
      wrapper: "scripts/run-oxlint.mts",
      argv: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts/check-changed.mts"],
      cwd: repo.dir,
    });
    const expectedTsgolint = createCheckProofReceipt({
      command: tsgolintCommand,
      context,
      exitCode: 0,
      expectedWrapperProof: tsgolintProof,
      wrapperProof: tsgolintProof,
    });
    const tsgoProof = createWrapperProof({
      tool: "tsgo",
      wrapper: "scripts/run-tsgo.mts",
      argv: ["-p", "scripts/tsconfig.json", "--noEmit"],
      cwd: repo.dir,
    });
    const storedTsgo = createCheckProofReceipt({
      command: {
        name: "typecheck scripts",
        bin: "node",
        args: ["scripts/run-tsgo.mjs", "-p", "scripts/tsconfig.json", "--noEmit"],
        env: { PATH: "/usr/bin" },
      },
      context,
      exitCode: 0,
      expectedWrapperProof: tsgoProof,
      wrapperProof: tsgoProof,
    });
    writeFileSync(
      path.join(receiptDir, `${expectedTsgolint.fingerprint}.json`),
      prettyJson({ ...storedTsgo, fingerprint: expectedTsgolint.fingerprint }),
      "utf8",
    );

    expect(evaluateReusableReceipt(receiptDir, expectedTsgolint)).toEqual(
      expect.objectContaining({
        reusable: false,
        reason: "changed-check evidence receipt command family mismatch",
      }),
    );
  });

  it("rejects skipped wrapper proof markers as non-proof", () => {
    const dir = makeTempRepoRoot(tempDirs, "wrapper-proof-");
    const receiptPath = path.join(dir, "proof.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify(
        {
          status: "skipped",
          exitCode: 0,
          ranTool: false,
          tool: "tsgo",
          wrapper: "scripts/run-tsgo.mts",
          argv: ["-p", "tsconfig.core.json"],
          wrapperDigest: "digest",
          toolDigest: null,
          configDigests: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(readWrapperProofReceipt(receiptPath)).toBeNull();
    writeWrapperProofReceipt(
      receiptPath,
      createWrapperProof({
        tool: "tsgo",
        wrapper: "scripts/run-tsgo.mts",
        argv: ["-p", "tsconfig.core.json"],
        cwd: repoRoot,
      }),
    );

    expect(readWrapperProofReceipt(receiptPath)).toEqual(
      expect.objectContaining({
        tool: "tsgo",
        status: "passed",
        exitCode: 0,
        ranTool: true,
        wrapper: "scripts/run-tsgo.mts",
      }),
    );
  });

  it("cleans CI Corepack pnpm shim temp dirs", () => {
    const command = createPnpmManagedCommand(
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { CI: "1", PATH: "/usr/bin" },
    );
    const shimDir = expectDefined(
      (command.env?.PATH ?? "").split(path.delimiter)[0],
      "CI Corepack pnpm shim directory",
    );

    expect(path.basename(shimDir)).toMatch(/^openclaw-corepack-pnpm-/u);
    expect(existsSync(path.join(shimDir, "pnpm"))).toBe(true);

    cleanupCorepackPnpmShimDir();

    expect(existsSync(shimDir)).toBe(false);
  });

  it("keeps local changed-check children on the repo pnpm shim", () => {
    const command = createPnpmManagedCommand(
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { PATH: "/usr/bin" },
    );

    expect(command.bin).toBe("pnpm");
    expect(command.args).toEqual(["check:no-conflict-markers"]);
  });

  it("delegates heavy changed gates after classifying their lanes", () => {
    const result = detectChangedLanes(["src/config/config.ts"]);
    expect(
      shouldDelegateChangedCheckToCrabbox(
        ["--base", "origin/main"],
        { PATH: "/usr/bin" },
        { result },
      ),
    ).toBe(true);
    expect(changedCheckRequiresRemote(result)).toBe(true);

    const proofExportPath = ".artifacts/check-changed-proof-export/testnonce.json";
    const receiptDir = makeTempRepoRoot(tempDirs, "changed-check-empty-proof-bundle-");
    const args = buildChangedCheckCrabboxArgs(["--base", "origin/main", "--head", "HEAD"], {
      proofExportPath,
      proofReceiptDir: receiptDir,
    });

    expect(args).toEqual([
      "scripts/crabbox-wrapper.mjs",
      "run",
      "--workload",
      "ci-fast",
      "--idle-timeout",
      "90m",
      "--ttl",
      "240m",
      "--timing-json",
      "--artifact-glob",
      proofExportPath,
      "--require-artifact",
      proofExportPath,
      "--",
      "env",
      "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1",
      "OPENCLAW_CHANGED_LANES_RAW_SYNC=1",
      "CI=1",
      "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false",
      `OPENCLAW_CHECK_CHANGED_PROOF_EXPORT=${proofExportPath}`,
      "corepack",
      "pnpm",
      "check:changed",
      "--base",
      "origin/main",
      "--head",
      "HEAD",
    ]);
    expect(args).not.toContain("--download");
    expect(args.some((arg) => /SKIP|skip/u.test(arg))).toBe(false);

    const fixture = createStoredProof({
      commandName: "typecheck core",
      producerContents: "export const core = 23;\n",
      producerPath: "src/core.ts",
    });
    const bundledArgs = buildChangedCheckCrabboxArgs(["--base", "origin/main"], {
      proofExportPath,
      proofReceiptDir: fixture.receiptDir,
    });
    const bundleEnv = expectDefined(
      bundledArgs.find((arg) => arg.startsWith("OPENCLAW_CHECK_CHANGED_PRIOR_RECEIPTS_B64=")),
      "prior bundle env",
    );
    const decoded = decodeCheckProofReceiptBundleFromEnv(
      bundleEnv.slice("OPENCLAW_CHECK_CHANGED_PRIOR_RECEIPTS_B64=".length),
    );
    expect(decoded).toEqual(
      expect.objectContaining({
        ok: true,
        bundle: expect.objectContaining({ receipts: [fixture.receipt] }),
      }),
    );
  });

  it("routes a changed export signature remotely through its own source lane", () => {
    // Detection only fires for source files, and any such file already enables a
    // non-docs lane, so the dead export scan needs no special routing branch.
    const result = detectChangedLanes(["src/config/config.ts"]);

    expect(changedCheckRequiresRemote(result)).toBe(true);
    expect(shouldDelegateChangedCheckToCrabbox([], {}, { result })).toBe(true);
  });

  it("adds the dead export scan only for production source changes", () => {
    const command = {
      name: "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
      bin: "node",
      args: ["--import", "tsx", "scripts/check-deadcode-exports.mts"],
      env: expect.any(Object),
    };
    const sourceResult = detectChangedLanes(["src/config/config.ts"]);
    const toolingResult = detectChangedLanes(["scripts/check-changed.mjs"]);

    expect(createChangedCheckPlan(sourceResult).commands).toContainEqual(command);
    expect(createChangedCheckPlan(toolingResult).commands).not.toContainEqual(command);
    expect(
      createChangedCheckPlan(sourceResult, {
        env: { OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE: "1" },
      }).commands,
    ).not.toContainEqual(command);
  });

  it("keeps small changed gates local only with a ready dependency install", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-local-route-");
    const docsResult = detectChangedLanes(["docs/reference/test.md"]);
    const noChangesResult = detectChangedLanes([]);
    const metadataResult = detectChangedLanes(["CHANGELOG.md"]);
    const mixedResult = detectChangedLanes(["CHANGELOG.md", "src/config/config.ts"]);

    expect(changedCheckLocalDependenciesReady(dir)).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], {}, { cwd: dir, result: noChangesResult })).toBe(
      false,
    );
    expect(shouldDelegateChangedCheckToCrabbox([], {}, { cwd: dir, result: docsResult })).toBe(
      true,
    );

    writeRepoFile(dir, "node_modules/.modules.yaml", "layoutVersion: 5\n");
    writeRepoFile(dir, "node_modules/.bin/oxfmt", "#!/bin/sh\n");
    writeRepoFile(dir, "node_modules/typescript/package.json", '{"name":"typescript"}\n');

    expect(changedCheckLocalDependenciesReady(dir)).toBe(true);
    for (const result of [docsResult, noChangesResult, metadataResult]) {
      expect(changedCheckRequiresRemote(result)).toBe(false);
      expect(shouldDelegateChangedCheckToCrabbox([], {}, { cwd: dir, result })).toBe(false);
    }
    for (const result of [docsResult, metadataResult]) {
      expect(
        shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_TESTBOX: "1" }, { cwd: dir, result }),
      ).toBe(true);
    }
    expect(changedCheckRequiresRemote(mixedResult)).toBe(true);
  });

  it("delegates generated docs baselines with heavy owner checks", () => {
    for (const changedPath of [
      "docs/.generated/plugin-sdk-api-baseline/core.json",
      "docs/.generated/sqlite-session-transcript-schema-baseline.sha256",
    ]) {
      const result = detectChangedLanes([changedPath]);
      expect(result.docsOnly).toBe(true);
      expect(changedCheckRequiresRemote(result)).toBe(true);
      expect(shouldDelegateChangedCheckToCrabbox([], {}, { cwd: repoRoot, result })).toBe(true);
    }
  });

  it("delegates staged changed gates as explicit remote paths", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-staged-delegate-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "staged.ts"), "export const staged = 1;\n", "utf8");
    git(dir, ["add", "src/staged.ts"]);

    const args = buildChangedCheckCrabboxArgs(["--staged", "--timed"], { cwd: dir });
    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual([
      "--timed",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--",
      "src/staged.ts",
    ]);
  });

  it("delegates empty staged changed gates without rediscovering unstaged paths", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-empty-staged-delegate-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "unstaged.ts"), "export const unstaged = 1;\n", "utf8");

    const args = buildChangedCheckCrabboxArgs(["--staged", "--timed"], { cwd: dir });

    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual(["--timed", "--no-changes"]);
  });

  it("does not delegate dry-run, CI, or remote-child changed gates", () => {
    expect(shouldDelegateChangedCheckToCrabbox(["--dry-run"], {})).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { GITHUB_ACTIONS: "true" })).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { CI: "1" })).toBe(false);
    expect(
      shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1" }),
    ).toBe(false);
  });

  it("runs changed-check lint lanes under the parent heavy-check lock", () => {
    const result = detectChangedLanes(["extensions/lmstudio/src/api.ts"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
    const lintCommand = plan.commands.find(
      (command) => command.name === "lint extension changed file",
    );

    expect(lintCommand?.env).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it("runs changed-check app tests under the parent heavy-check lock", () => {
    const result = detectChangedLanes([
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
    ]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
    const testCommand = plan.commands.find((command) => command.args[0] === "test:macos:ci");

    expect(testCommand?.env).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it.each([
    {
      name: "routes core test-only changes to core test lanes only",
      path: "packages/normalization-core/src/string-normalization.test-support.ts",
      expected: {
        lanes: { coreTests: true },
        includes: ["tsgo:core:test"],
        excludes: ["tsgo:core"],
      },
    },
    {
      name: "routes extension production changes to extension prod and extension test lanes",
      path: "extensions/lmstudio/src/api.ts",
      expected: {
        lanes: { extensions: true, extensionTests: true },
        includes: ["tsgo:extensions", "tsgo:extensions:test"],
        excludes: [],
      },
    },
    {
      name: "routes extension test-only changes to extension test lanes only",
      path: "extensions/discord/src/index.test-helpers.ts",
      expected: {
        lanes: { extensionTests: true },
        includes: ["tsgo:extensions:test"],
        excludes: ["tsgo:extensions"],
      },
    },
  ])("$name", ({ path: changedPath, expected }) => {
    const result = detectChangedLanes([changedPath]);
    const commands = createChangedCheckPlan(result).commands.map((command) => command.args[0]);

    expectLanes(result.lanes, expected.lanes);
    for (const command of expected.includes) {
      expect(commands).toContain(command);
    }
    for (const command of expected.excludes) {
      expect(commands).not.toContain(command);
    }
  });

  it("expands public core/plugin contracts to extension validation", () => {
    const result = detectChangedLanes(["src/plugin-sdk/core.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(result.extensionImpactFromCore).toBe(true);
    expectLanes(result.lanes, {
      core: true,
      coreTests: true,
      extensions: true,
      extensionTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions:test");
  });

  it("keeps evidence-capable changed checks scoped to affected lane plans", () => {
    const hasEvidenceCapableCommand = (paths: string[]) =>
      createChangedCheckPlan(detectChangedLanes(paths)).commands.some((command) =>
        command.args.some(
          (arg) =>
            arg.startsWith("tsgo:") ||
            arg === "lint:core" ||
            arg === "lint:extensions" ||
            arg.includes("run-oxlint"),
        ),
      );

    expect(hasEvidenceCapableCommand(["docs/ci.md"])).toBe(false);
    expect(
      hasEvidenceCapableCommand([
        "package.json",
        "CHANGELOG.md",
        "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
        "docs/.generated/config-baseline.counts.json",
        "docs/.generated/config-baseline.sha256",
      ]),
    ).toBe(false);
    expect(hasEvidenceCapableCommand(["src/agents/run.ts"])).toBe(true);
    expect(hasEvidenceCapableCommand(["src/plugin-sdk/core.ts"])).toBe(true);

    const rootResult = detectChangedLanes(["pnpm-lock.yaml"]);
    expect(rootResult.lanes.all).toBe(true);
    expect(createChangedCheckPlan(rootResult).commands.map((command) => command.args[0])).toContain(
      "tsgo:all",
    );
  });

  it("fails safe for root config changes", () => {
    const result = detectChangedLanes(["pnpm-lock.yaml"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.all).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it.each([
    {
      name: "routes gitignore changes to tooling instead of all lanes",
      paths: [".gitignore"],
      excludesTests: true,
    },
    {
      name: "routes root hygiene config changes to tooling instead of all lanes",
      paths: [
        ".dockerignore",
        ".jscpd.json",
        ".npmignore",
        ".pre-commit-config.yaml",
        ".swiftformat",
        ".swiftlint.yml",
        "Makefile",
        "config/knip.config.ts",
        "config/markdownlint-cli2.jsonc",
        "config/shellcheckrc",
        "config/swiftformat",
        "config/swiftlint.yml",
        "deploy/fly.private.toml",
        "docker-setup.sh",
        "openclaw.podman.env",
        "setup-podman.sh",
        "skills/pyproject.toml",
      ],
      excludesTests: true,
    },
    {
      name: "routes VS Code workspace settings to tooling instead of all lanes",
      paths: [".vscode/settings.json", ".vscode/extensions.json"],
      excludesTests: true,
    },
    {
      name: "routes legacy root sandbox Dockerfile moves to tooling instead of all lanes",
      paths: [
        "Dockerfile.sandbox",
        "Dockerfile.sandbox-browser",
        "Dockerfile.sandbox-common",
        "scripts/docker/sandbox/Dockerfile",
        "scripts/docker/sandbox/Dockerfile.browser",
        "scripts/docker/sandbox/Dockerfile.common",
      ],
      excludesTests: true,
    },
    {
      name: "routes legacy root asset deletions as tooling during root cleanup",
      paths: ["assets/avatar-placeholder.svg", "assets/chrome-extension/icons/icon128.png"],
      excludesTests: false,
    },
  ])("$name", ({ paths, excludesTests }) => {
    const result = detectChangedLanes(paths);
    const commands = createChangedCheckPlan(result).commands.map((command) => command.args[0]);

    expectLanes(result.lanes, { tooling: true });
    expect(commands).toContain("lint:scripts");
    expect(commands).not.toContain("tsgo:all");
    if (excludesTests) {
      expect(commands).not.toContain("test");
    }
  });

  it("routes live Docker ACP tooling changes through a focused gate", () => {
    const result = detectChangedLanes([
      "scripts/lib/live-docker-auth.sh",
      "scripts/test-docker-all.mjs",
      "scripts/test-live-acp-bind-docker.sh",
      "src/gateway/gateway-acp-bind.live.test.ts",
      "docs/help/testing-live.md",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      docs: true,
      liveDockerTooling: true,
    });
    expect(plan.commands.map((command) => command.name)).toEqual([
      "conflict markers",
      "environment variable count ratchet",
      "max-lines suppression ratchet",
      "changelog attributions",
      "doctor deprecation registry",
      "guarded extension wildcard re-exports",
      "plugin-sdk wildcard re-exports",
      "duplicate scan target coverage",
      "coercion helper declaration guard",
      "dependency pin guard",
      "format changed files",
      "deprecated API usage",
      "plugin boundaries",
      "wrapper shadowing",
      "package patch guard",
      // These live-Docker paths include `src/gateway/*.live.test.ts`, and the
      // full-tree knip scan sees test files, so a deleted last consumer can
      // orphan an export here too.
      "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
      "test temp creation report (warning-only)",
      "typecheck core tests",
      "lint core",
      "lint scripts",
      "live Docker shell syntax",
      "live Docker scheduler dry run",
    ]);
    expect(plan.commands.find((command) => command.name === "live Docker shell syntax")).toEqual({
      name: "live Docker shell syntax",
      bin: "bash",
      args: [
        "-n",
        "scripts/lib/live-docker-auth.sh",
        "scripts/test-live-acp-bind-docker.sh",
        "scripts/test-live-cli-backend-docker.sh",
        "scripts/test-live-codex-harness-docker.sh",
        "scripts/test-live-gateway-models-docker.sh",
        "scripts/test-live-models-docker.sh",
        "scripts/test-live-subagent-announce-docker.sh",
      ],
    });
    const schedulerDryRun = plan.commands.find(
      (command) => command.name === "live Docker scheduler dry run",
    );
    expect(schedulerDryRun?.bin).toBe("node");
    expect(schedulerDryRun?.args).toEqual(["scripts/test-docker-all.mjs"]);
    expect(schedulerDryRun?.env?.OPENCLAW_DOCKER_ALL_DRY_RUN).toBe("1");
    expect(schedulerDryRun?.env?.OPENCLAW_DOCKER_ALL_LIVE_MODE).toBe("only");
  });

  it("routes live Docker package script-only changes through the focused gate", () => {
    const before = prettyJson({
      name: "fixture",
      scripts: { "test:docker:all": "node scripts/test-docker-all.mjs" },
      dependencies: { leftpad: "1.0.0" },
    });
    const after = prettyJson({
      name: "fixture",
      scripts: {
        "test:docker:all": "node scripts/test-docker-all.mjs",
        "test:docker:live-acp-bind:droid":
          "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
      },
      dependencies: { leftpad: "1.0.0" },
    });

    expect(isLiveDockerPackageScriptOnlyChange(before, after)).toBe(true);

    const result = detectChangedLanes(["package.json"], {
      packageJsonChangeKind: "liveDockerTooling",
    });
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      liveDockerTooling: true,
    });
    expect(plan.commands.map((command) => command.name)).toContain("live Docker scheduler dry run");
  });

  it.each([
    {
      name: "classifies live Docker package script changes from the git diff",
      prefix: "openclaw-live-docker-package-",
      before: {
        name: "fixture",
        scripts: { "test:docker:all": "node scripts/test-docker-all.mjs" },
      },
      after: {
        name: "fixture",
        scripts: {
          "test:docker:all": "node scripts/test-docker-all.mjs",
          "test:docker:live-acp-bind:droid":
            "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
        },
      },
      expected: { liveDockerTooling: true },
    },
    {
      name: "classifies normal package script changes from the git diff",
      prefix: "openclaw-package-scripts-",
      before: {
        name: "fixture",
        scripts: { test: "node --import tsx scripts/test-projects.mts" },
        dependencies: { leftpad: "1.0.0" },
      },
      after: {
        name: "fixture",
        scripts: {
          test: "node --import tsx scripts/test-projects.mts",
          "test:profile": "node scripts/profile-tests.mjs",
        },
        dependencies: { leftpad: "1.0.0" },
      },
      expected: { tooling: true },
    },
  ])("$name", ({ prefix, before, after, expected }) => {
    const result = classifyPackageJsonChange(prefix, before, after);

    expect(result.paths).toEqual(["package.json"]);
    expectLanes(result.lanes, expected);
  });

  it("keeps non-script package changes off the live Docker focused gate", () => {
    const before = prettyJson({
      name: "fixture",
      scripts: {},
      dependencies: { leftpad: "1.0.0" },
    });
    const after = prettyJson({
      name: "fixture",
      scripts: {
        "test:docker:live-acp-bind:droid":
          "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
      },
      dependencies: { leftpad: "1.0.1" },
    });

    expect(isLiveDockerPackageScriptOnlyChange(before, after)).toBe(false);
  });

  it("routes package script-only changes through the tooling gate", () => {
    const before = prettyJson({
      name: "fixture",
      scripts: { test: "node test.js" },
      dependencies: { leftpad: "1.0.0" },
    });
    const after = prettyJson({
      name: "fixture",
      scripts: { test: "node test.js", "test:profile": "node scripts/profile-tests.mjs" },
      dependencies: { leftpad: "1.0.0" },
    });

    expect(isPackageScriptOnlyChange(before, after)).toBe(true);

    const result = detectChangedLanes(["package.json"], {
      packageJsonChangeKind: "tooling",
    });
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("keeps release metadata commits off the full changed gate", () => {
    const result = detectChangedLanes([
      "CHANGELOG.md",
      "apps/android/CHANGELOG.md",
      "apps/android/Config/Version.properties",
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
      "apps/android/version.json",
      "apps/ios/CHANGELOG.md",
      "apps/macos/Sources/OpenClaw/Resources/Info.plist",
      "docs/.generated/config-baseline.counts.json",
      "docs/.generated/config-baseline.sha256",
      "package.json",
    ]);
    const plan = createChangedCheckPlan(result, { staged: true });

    expectLanes(result.lanes, {
      docs: true,
      releaseMetadata: true,
    });
    const commands = plan.commands.map((command) => command.args[0]);
    expect(commands).toEqual([
      "check:no-conflict-markers",
      "check:changelog-attributions",
      "check:doctor-deprecation-registry",
      "lint:extensions:no-guarded-wildcard-reexports",
      "lint:extensions:no-plugin-sdk-wildcard-reexports",
      "dup:check:coverage",
      "check:coercion-helpers",
      "deps:pins:check",
      "format:check",
      "--import",
      "check:deprecated-api-usage",
      "plugins:boundary-report:ci",
      "check:wrapper-shadowing",
      "deps:patches:check",
      "release-metadata:check",
      "android:version:check",
      "config:schema:check",
      "config:docs:check",
      "deps:root-ownership:check",
    ]);
    expect(commands).not.toContain("ios:version:check");
    expect(
      plan.commands.find((command) => command.args[0] === "release-metadata:check")?.args,
    ).toEqual(["release-metadata:check", "--staged"]);
  });

  it("passes release metadata base and head refs as options", () => {
    const result = detectChangedLanes(["CHANGELOG.md"]);
    const plan = createChangedCheckPlan(result, { base: "main", head: "feature" });

    expect(
      plan.commands.find((command) => command.args[0] === "release-metadata:check")?.args,
    ).toEqual(["release-metadata:check", "--base", "main", "--head", "feature"]);
  });

  it("keeps docs plus changelog entries on the docs-only changed gate", () => {
    const result = detectChangedLanes(["CHANGELOG.md", "docs/tools/index.md"]);
    const plan = createChangedCheckPlan(result);

    expect(result.docsOnly).toBe(true);
    expectLanes(result.lanes, {
      docs: true,
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain("release-metadata:check");
  });

  it("runs the npm package-lock guard for dependency package surfaces", () => {
    expect(
      shouldRunNpmLockGuard([
        "extensions/slack/package.json",
        "extensions/slack/deps/local-runtime/package.json",
        "scripts/generate-npm-package-lock.mts",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["extensions/slack/package.json"]);
    const plan = createChangedCheckPlan(result);
    const npmLockGuard = createNpmLockGuardCommand(["extensions/slack/package.json"]);

    expect(npmLockGuard?.args.slice(0, 3)).toEqual([
      "--import",
      "tsx",
      "scripts/generate-npm-package-lock.mts",
    ]);
    expect(
      npmLockGuard?.args.some((arg) => arg.replaceAll("\\", "/").endsWith("extensions/slack")),
    ).toBe(true);
    expect(plan.commands.map((command) => command.name)).toContain("npm package-lock guard");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("deps:npm-lock:check");
  });

  it.each([
    {
      name: "runs prompt snapshot drift checks for prompt snapshot generator surfaces",
      predicate: shouldRunPromptSnapshotCheck,
      predicatePaths: [
        "scripts/generate-prompt-snapshots.ts",
        "test/helpers/agents/happy-path-prompt-snapshots.ts",
        "test/fixtures/agents/prompt-snapshots/runtime-happy-path/telegram-direct-codex-message-tool.md",
      ],
      changedPath: "test/helpers/agents/happy-path-prompt-snapshots.ts",
      expected: {
        exact: [{ name: "prompt snapshot drift", args: ["prompt:snapshots:check"] }],
        partial: [
          {
            name: "prompt snapshot owner test",
            args: ["test:serial", "test/scripts/prompt-snapshots.test.ts"],
          },
        ],
      },
    },
    {
      name: "runs the prompt snapshot owner test for model fixture generator surfaces",
      predicate: shouldRunPromptSnapshotOwnerTest,
      predicatePaths: [
        "scripts/sync-codex-model-prompt-fixture.ts",
        "test/fixtures/agents/prompt-snapshots/codex-model-catalog/gpt-5.5.pragmatic.source.json",
      ],
      changedPath: "scripts/sync-codex-model-prompt-fixture.ts",
      expected: {
        exact: [],
        partial: [
          {
            name: "prompt snapshot owner test",
            args: ["test:serial", "test/scripts/prompt-snapshots.test.ts"],
          },
        ],
      },
    },
    {
      name: "runs runtime sidecar baseline checks for baseline owner surfaces",
      predicate: shouldRunRuntimeSidecarBaselineCheck,
      predicatePaths: [
        "scripts/generate-runtime-sidecar-paths-baseline.ts",
        "scripts/lib/bundled-runtime-sidecar-paths.json",
        "src/plugins/runtime-sidecar-paths-baseline.ts",
        "src/plugins/runtime-sidecar-paths.ts",
      ],
      changedPath: "scripts/lib/bundled-runtime-sidecar-paths.json",
      expected: {
        exact: [{ name: "runtime sidecar baseline", args: ["runtime-sidecars:check"] }],
        partial: [
          {
            name: "runtime sidecar owner test",
            args: ["test:serial", "src/plugins/bundled-plugin-metadata.test.ts"],
          },
        ],
      },
    },
    {
      name: "runs doctor contract owner tests for extension module and manifest changes",
      predicate: shouldRunDoctorContractOwnerTests,
      predicatePaths: [
        "extensions/telegram/doctor-contract-api.ts",
        "extensions/telegram/openclaw.plugin.json",
        "extensions/codex/src/migration/session-binding-sidecars.ts",
      ],
      changedPath: "extensions/telegram/doctor-contract-api.ts",
      expected: {
        exact: [],
        partial: [
          {
            name: "doctor contract declaration + closure guard tests",
            args: [
              "test:serial",
              "src/plugins/doctor-contract-declarations.test.ts",
              "src/plugins/doctor-contract-closure-guard.test.ts",
            ],
          },
        ],
      },
    },
    {
      name: "runs SQLite sessions/transcripts schema baseline checks for baseline owner surfaces",
      predicate: shouldRunSqliteSessionSchemaBaselineCheck,
      predicatePaths: [
        "src/state/openclaw-agent-schema.sql",
        "scripts/generate-sqlite-session-schema-baseline.ts",
        "scripts/lib/sqlite-session-schema-baseline.ts",
        "test/scripts/sqlite-session-schema-baseline.test.ts",
        "docs/.generated/sqlite-session-transcript-schema-baseline.sha256",
      ],
      changedPath: "src/state/openclaw-agent-schema.sql",
      expected: {
        exact: [
          {
            name: "SQLite sessions/transcripts schema baseline",
            args: ["sqlite:sessions-schema:check"],
          },
        ],
        partial: [],
      },
    },
  ])("$name", ({ predicate, predicatePaths, changedPath, expected }) => {
    expect(predicate(predicatePaths)).toBe(true);
    const commands = createChangedCheckPlan(detectChangedLanes([changedPath])).commands;
    for (const command of expected.exact) {
      expect(commands).toContainEqual(command);
    }
    for (const command of expected.partial) {
      expect(commands).toContainEqual(expect.objectContaining(command));
    }
  });

  it("runs Plugin SDK API checks for transitive public contract changes", () => {
    expect(
      shouldRunPluginSdkApiBaselineCheck([
        "src/config/sessions/session-accessor.ts",
        "packages/gateway-protocol/src/schema/approvals.ts",
        "extensions/memory-core/index.ts",
        "scripts/generate-plugin-sdk-api-baseline.ts",
        "scripts/lib/plugin-sdk-doc-metadata.ts",
        "scripts/lib/plugin-sdk-entries.mts",
        "docs/.generated/plugin-sdk-api-baseline/core.json",
      ]),
    ).toBe(true);
    expect(shouldRunPluginSdkApiBaselineCheck(["docs/help/troubleshooting.md"])).toBe(false);

    const result = detectChangedLanes(["src/config/sessions/session-accessor.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual({
      name: "Plugin SDK API contract manifest",
      args: ["plugin-sdk:api:check"],
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain(
      "plugin-sdk:surface:check",
    );
  });

  it("runs Plugin SDK export and surface checks for direct SDK changes", () => {
    expect(
      shouldRunPluginSdkSurfaceChecks([
        "src/plugin-sdk/core.ts",
        "scripts/plugin-sdk-surface-report.mts",
        "scripts/sync-plugin-sdk-exports.mts",
        "scripts/lib/plugin-sdk-entries.mts",
        "scripts/lib/plugin-sdk-entrypoints.json",
        "package.json",
      ]),
    ).toBe(true);
    expect(shouldRunPluginSdkSurfaceChecks(["src/config/sessions/session-accessor.ts"])).toBe(
      false,
    );

    const result = detectChangedLanes(["src/plugin-sdk/core.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual({
      name: "Plugin SDK API contract manifest",
      args: ["plugin-sdk:api:check"],
    });
    expect(plan.commands).toContainEqual({
      name: "Plugin SDK package exports",
      args: ["plugin-sdk:check-exports"],
    });
    expect(plan.commands).toContainEqual({
      name: "Plugin SDK surface budget",
      args: ["plugin-sdk:surface:check"],
    });

    const releaseMetadataPlan = createChangedCheckPlan(
      detectChangedLanes(["CHANGELOG.md", "package.json"]),
    );
    expect(releaseMetadataPlan.commands.map((command) => command.args[0])).not.toContain(
      "plugin-sdk:check-exports",
    );
  });

  it("runs deprecation hygiene checks for outcome-changing paths and all lanes", () => {
    expect(
      shouldRunDeprecationHygieneChecks([
        "src/plugin-sdk/core.ts",
        "extensions/slack/index.ts",
        "packages/gateway-protocol/src/index.ts",
        "scripts/lib/plugin-sdk-entries.mts",
        "scripts/check-deprecated-api-usage.mts",
        "scripts/plugin-boundary-report.ts",
        "src/plugins/compat/registry.ts",
        "package.json",
      ]),
    ).toBe(true);
    expect(shouldRunDeprecationHygieneChecks(["docs/plugins/sdk-migration.md"])).toBe(false);

    for (const result of [
      detectChangedLanes(["extensions/slack/index.ts"]),
      detectChangedLanes(["unknown-surface.foo"]),
    ]) {
      const plan = createChangedCheckPlan(result);
      expect(plan.commands).toContainEqual({
        name: "deprecated API usage",
        args: ["check:deprecated-api-usage"],
      });
      expect(plan.commands).toContainEqual({
        name: "plugin boundaries",
        args: ["plugins:boundary-report:ci"],
      });
    }
  });

  it("runs wrapper shadowing for source and guard-owner changes", () => {
    expect(
      shouldRunWrapperShadowingCheck([
        "src/channels/turn/run-channel-turn.ts",
        "scripts/check-wrapper-shadowing.mts",
        "scripts/check-export-name-collisions.mts",
        "scripts/lib/wrapper-shadowing-baseline.json",
        "scripts/lib/ts-guard-utils.mts",
        "package.json",
      ]),
    ).toBe(true);
    expect(shouldRunWrapperShadowingCheck(["docs/concepts/message-lifecycle.md"])).toBe(false);

    const plan = createChangedCheckPlan(
      detectChangedLanes(["scripts/check-wrapper-shadowing.mts"]),
    );
    expect(plan.commands).toContainEqual({
      name: "wrapper shadowing",
      args: ["check:wrapper-shadowing"],
    });
  });

  it("guards release metadata package changes to the top-level version field", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-release-metadata-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.20", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    commitAll(dir, "initial");

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    expect(
      execFileSync(
        process.execPath,
        [
          "--import",
          tsxImport,
          path.join(repoRoot, "scripts", "check-release-metadata-only.mts"),
          "--staged",
        ],
        {
          cwd: dir,
          env: {
            ...createNestedGitEnv(),
            TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
          },
          stdio: "pipe",
        },
      ),
    ).toBeInstanceOf(Buffer);

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.1" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    let failure: ExecFileSyncFailure | undefined;
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          tsxImport,
          path.join(repoRoot, "scripts", "check-release-metadata-only.mts"),
          "--staged",
        ],
        {
          cwd: dir,
          env: {
            ...createNestedGitEnv(),
            TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
          },
          stdio: "pipe",
        },
      );
    } catch (error) {
      failure = error as ExecFileSyncFailure;
    }

    expect(failure?.status).toBe(1);
    expect(failure?.stderr?.toString("utf8")).toContain(
      "[release-metadata] package.json changed outside the top-level version field",
    );
  });

  it("routes root test/support changes to the tooling test lane instead of all lanes", () => {
    const result = detectChangedLanes([
      "test/git-hooks-pre-commit.test.ts",
      "test-fixtures/legacy-root-fixture.json",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      testRoot: true,
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes legacy Swabble deletions as app surface during the app move", () => {
    const result = detectChangedLanes(["Swabble/Sources/SwabbleKit/WakeWordGate.swift"]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      apps: true,
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("runs macOS app CI tests for macOS app dependency changes", () => {
    for (const changedPath of [
      "apps/macos/Sources/OpenClawMac/AppDelegate.swift",
      "apps/macos-mlx-tts/Sources/OpenClawMLXTTS/main.swift",
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
      "apps/swabble/Sources/SwabbleKit/WakeWordGate.swift",
      "Swabble/Sources/SwabbleKit/WakeWordGate.swift",
    ]) {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result, {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:apps");
      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "lint apps (swiftlint unavailable on this host)",
          bin: "node",
        }),
      );
      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "macOS app CI tests",
          args: ["test:macos:ci"],
        }),
      );
    }
  });

  it("runs macOS CI tests for workspace rsync receiver owners", () => {
    for (const changedPath of [
      "src/worker/workspace-rsync-receiver.ts",
      "src/gateway/worker-environments/workspace-sync.ts",
      "src/gateway/worker-environments/workspace-sync-helpers.ts",
      "src/gateway/worker-environments/workspace-accepted-sync.ts",
      "src/gateway/worker-environments/workspace-accepted-remote-script.ts",
      "src/gateway/worker-environments/workspace-mutation-remote-script.ts",
      "src/gateway/worker-environments/workspace-rsync-path.test.ts",
    ]) {
      const plan = createChangedCheckPlan(detectChangedLanes([changedPath]), {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "macOS app CI tests",
          args: ["test:macos:ci"],
        }),
      );
    }
  });

  it("runs the native state schema guard for either contract owner", () => {
    for (const changedPath of [
      "apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift",
      "src/state/openclaw-state-db-contract.ts",
    ]) {
      const plan = createChangedCheckPlan(detectChangedLanes([changedPath]), {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "native state schema version guard",
          bin: "node",
          args: ["scripts/check-native-state-schema-version.mjs"],
        }),
      );
    }
  });

  it("runs macOS app CI tests for macOS packaging scripts and owner tests", () => {
    for (const changedPath of [
      "scripts/codesign-mac-app.sh",
      "scripts/create-dmg.sh",
      "scripts/lib/plistbuddy.sh",
      "scripts/lib/swift-toolchain.sh",
      "scripts/notarize-mac-artifact.sh",
      "scripts/package-mac-app.sh",
      "scripts/package-mac-dist.sh",
      "test/scripts/codesign-mac-app.test.ts",
      "test/scripts/create-dmg.test.ts",
      "test/scripts/notarize-mac-artifact.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/package-mac-dist.test.ts",
    ]) {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result, {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expectLanes(result.lanes, {
        testRoot: changedPath.endsWith(".ts"),
        tooling: true,
      });
      expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:apps");
      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "macOS app CI tests",
          args: ["test:macos:ci"],
        }),
      );
    }
  });

  it("routes appcast changes to appcast owner tests", () => {
    const result = detectChangedLanes(["appcast.xml"]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunAppcastOwnerTest(result.paths)).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "appcast owner tests",
        args: ["test:serial", "test/appcast.test.ts", "test/scripts/make-appcast.test.ts"],
      }),
    );
    expect(plan.commands.map((command) => command.name)).not.toContain("macOS app CI tests");
  });

  it("runs app lint when SwiftLint is available in Testbox", () => {
    const result = detectChangedLanes([
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
    ]);
    const plan = createChangedCheckPlan(result, {
      env: { CI: "1", PATH: "/usr/bin" },
      platform: "linux",
      swiftlintAvailable: true,
    });

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:apps");
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "macOS app CI tests",
        args: ["test:macos:ci"],
      }),
    );
  });

  it("keeps macOS app CI tests out of Android-only app changes", () => {
    const result = detectChangedLanes(["apps/android/app/src/main/AndroidManifest.xml"]);
    const plan = createChangedCheckPlan(result, {
      env: { CI: "1", PATH: "/usr/bin" },
      platform: "linux",
      swiftlintAvailable: true,
    });

    expectLanes(result.lanes, {
      apps: true,
    });
    expect(plan.commands.map((command) => command.name)).not.toContain("macOS app CI tests");
  });

  it("routes A2UI bundle source changes as extension changes", () => {
    const result = detectChangedLanes([
      "extensions/canvas/src/host/a2ui-app/bootstrap.js",
      "extensions/canvas/src/host/a2ui-app/rolldown.config.mjs",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      extensions: true,
      extensionTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "Canvas A2UI native resource generation",
        bin: "node",
        args: ["--import", "tsx", "scripts/sync-native-a2ui.mts", "--check"],
      }),
    );
  });

  it("checks native A2UI resources when the copied resource tree changes", () => {
    const result = detectChangedLanes([
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/a2ui.bundle.js",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      apps: true,
    });
    expect(shouldRunCanvasA2uiNativeResourceCheck(result.paths)).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "Canvas A2UI native resource generation",
        bin: "node",
        args: ["--import", "tsx", "scripts/sync-native-a2ui.mts", "--check"],
      }),
    );
  });

  it("checks native A2UI resources when bundle inputs or generated outputs change", () => {
    const result = detectChangedLanes([
      "extensions/canvas/package.json",
      "extensions/canvas/src/host/a2ui/.bundle.hash",
      "extensions/canvas/src/host/a2ui/a2ui.bundle.js",
      "pnpm-lock.yaml",
    ]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunCanvasA2uiNativeResourceCheck(result.paths)).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "Canvas A2UI native resource generation",
        bin: "node",
        args: ["--import", "tsx", "scripts/sync-native-a2ui.mts", "--check"],
      }),
    );
  });

  it.each([
    "apps/android/app/build.gradle.kts",
    "apps/ios/project.yml",
    "apps/linux/src-tauri/build.rs",
    "apps/linux/src-tauri/src/canvas.rs",
  ])("checks native A2UI ownership when %s changes", (ownerPath) => {
    const result = detectChangedLanes([ownerPath]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunCanvasA2uiNativeResourceCheck(result.paths)).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "Canvas A2UI native resource generation",
        bin: "node",
        args: ["--import", "tsx", "scripts/sync-native-a2ui.mts", "--check"],
      }),
    );
  });

  it.each([
    {
      name: "keeps shared Vitest wiring changes out of check test execution",
      paths: ["test/vitest/vitest.shared.config.ts"],
      expected: "lint:scripts",
    },
    {
      name: "keeps setup changes out of check test execution",
      paths: ["test/setup.ts"],
      expected: "lint:scripts",
    },
    {
      name: "does not route generated plugin bundle artifacts as direct Vitest targets",
      paths: [
        "extensions/demo/src/host/assets/.bundle.hash",
        "extensions/canvas/scripts/bundle-a2ui.test.ts",
      ],
      expected: "tsgo:extensions",
    },
    {
      name: "routes changed extension Vitest configs to only their owning shard",
      paths: ["test/vitest/vitest.extension-discord.config.ts"],
      expected: "lint:scripts",
    },
  ])("$name", ({ paths, expected }) => {
    const commands = createChangedCheckPlan(detectChangedLanes(paths)).commands.map(
      (command) => command.args[0],
    );

    expect(commands).toContain(expected);
    expect(commands).not.toContain("test");
  });

  it("adds the warning-only temp creation report for changed test paths", () => {
    const result = detectChangedLanes(["test/helpers/temp-fixture.ts"]);
    const plan = createChangedCheckPlan(result, { base: "main", head: "feature" });
    const command = plan.commands.find(
      (candidate) => candidate.name === "test temp creation report (warning-only)",
    );

    expect(shouldRunTestTempCreationReport(result.paths)).toBe(true);
    expect(command).toMatchObject({
      bin: "node",
      args: ["scripts/report-test-temp-creations.mjs", "--base", "main", "--head", "feature"],
    });
  });

  it.each([
    {
      name: "adds the max-lines suppression ratchet with worktree and staged bases",
      commandName: "max-lines suppression ratchet",
      worktreeOptions: { base: "main", head: "feature" },
      expected: {
        worktree: ["check:max-lines-ratchet", "--base", "main"],
        staged: ["check:max-lines-ratchet", "--staged", "--base", "HEAD"],
      },
    },
    {
      name: "adds the environment variable count ratchet for production source",
      commandName: "environment variable count ratchet",
      worktreeOptions: { base: "main" },
      expected: {
        worktree: ["check:env-var-count", "--base", "main"],
        staged: ["check:env-var-count", "--staged", "--base", "HEAD"],
      },
    },
  ])("$name", ({ commandName, worktreeOptions, expected }) => {
    const result = detectChangedLanes(["src/runtime.ts"]);
    const worktreePlan = createChangedCheckPlan(result, worktreeOptions);
    const stagedPlan = createChangedCheckPlan(result, { staged: true });

    expect(worktreePlan.commands.find((command) => command.name === commandName)).toMatchObject({
      args: expected.worktree,
    });
    expect(stagedPlan.commands.find((command) => command.name === commandName)).toMatchObject({
      args: expected.staged,
    });
  });

  it("keeps the temp creation report out of non-test changed paths", () => {
    const result = detectChangedLanes(["scripts/check-changed.mjs"]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunTestTempCreationReport(result.paths)).toBe(false);
    expect(plan.commands.map((command) => command.name)).not.toContain(
      "test temp creation report (warning-only)",
    );
  });

  it("keeps an empty changed path list as a no-op", () => {
    const result = detectChangedLanes([]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes).toEqual({
      core: false,
      coreTests: false,
      ui: false,
      extensions: false,
      extensionTests: false,
      scripts: false,
      testRoot: false,
      apps: false,
      docs: false,
      tooling: false,
      liveDockerTooling: false,
      bundledChannelConfigMetadata: false,
      releaseMetadata: false,
      all: false,
    });
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { name: "changelog attributions", args: ["check:changelog-attributions"] },
      { name: "doctor deprecation registry", args: ["check:doctor-deprecation-registry"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "coercion helper declaration guard", args: ["check:coercion-helpers"] },
      { name: "dependency pin guard", args: ["deps:pins:check"] },
      { name: "package patch guard", args: ["deps:patches:check"] },
    ]);
  });

  it("keeps docs-only changes cheap", () => {
    const result = detectChangedLanes(["docs/ci.md", "README.md"]);
    const plan = createChangedCheckPlan(result);

    expect(result.docsOnly).toBe(true);
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { name: "changelog attributions", args: ["check:changelog-attributions"] },
      { name: "doctor deprecation registry", args: ["check:doctor-deprecation-registry"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "coercion helper declaration guard", args: ["check:coercion-helpers"] },
      { name: "dependency pin guard", args: ["deps:pins:check"] },
      {
        name: "format changed files",
        args: ["format:check", "--no-error-on-unmatched-pattern", "--", "docs/ci.md", "README.md"],
      },
      { name: "package patch guard", args: ["deps:patches:check"] },
    ]);
  });
});

describe("delegationFailedBeforeRunning", () => {
  // The wrapper only prints a run summary once the command reached the box, so
  // the summary is the evidence that a verdict exists at all.
  it("treats a lease or network failure as never having run", () => {
    const output = [
      'request failed: Get "https://backend.blacksmith.sh/api/testbox/list?all=true": context deadline exceeded',
      "blacksmith testbox run exited 1",
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  it("treats a reported command exit as a real check failure", () => {
    const output = [
      "  64.95s  failed:1   typecheck core tests",
      '{"provider":"blacksmith-testbox","runStatus":"failed","errorKind":"command-exit","exitCode":1}',
    ].join("\n");

    // Falling back locally here would re-run on macOS and could pass a lane
    // whose truth is Linux, turning a red gate green.
    expect(delegationFailedBeforeRunning(output)).toBe(false);
  });

  it("treats a full workload-routing provider outage as never having run", () => {
    // Provider selection happens before any dispatch, so an exhausted routing
    // chain (every doctor failing) can never carry a remote verdict.
    const output = [
      "[crabbox] no ready provider for workload=ci-fast",
      "[crabbox] provider readiness blacksmith-testbox:doctor exited 1,daytona:doctor exited 124,azure:doctor exited 124,aws:doctor exited 124",
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  it("does not mistake an infrastructure error kind for a command verdict", () => {
    const output = [
      "failed to acquire lease for testbox",
      '{"provider":"blacksmith-testbox","runStatus":"failed","errorKind":"lease-timeout","exitCode":1}',
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  // A crash after dispatch produces no summary either, so absence of one cannot
  // be read as "never ran" — that is how an unknown Linux result would go green.
  it("fails closed when the wrapper dies without saying why", () => {
    expect(delegationFailedBeforeRunning("node: killed\n")).toBe(false);
    expect(delegationFailedBeforeRunning("")).toBe(false);
  });

  it("keeps a command verdict authoritative even alongside network noise", () => {
    const output = [
      'request failed: Get "https://backend.blacksmith.sh/api/testbox/list": context deadline exceeded',
      '{"provider":"blacksmith-testbox","runStatus":"failed","errorKind":"command-exit","exitCode":1}',
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(false);
  });
});
