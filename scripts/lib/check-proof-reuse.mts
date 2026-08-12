import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./record-shared.mjs";

export type CommandFamily = "tsgo" | "tsgolint" | "other";

export type ProofCommand = {
  name: string;
  args: string[];
  bin?: string;
  env?: NodeJS.ProcessEnv;
};

export type ProofRunContext = {
  base?: string;
  head?: string;
  changedPaths: string[];
  planSummary: string;
  planCommands?: ProofCommand[];
  reuseBlockers?: string[];
  cwd?: string;
};

export type WrapperProof = {
  status: "passed" | "failed" | "skipped";
  exitCode: number;
  ranTool: boolean;
  tool: "tsgo" | "tsgolint";
  wrapper: string;
  argv: string[];
  wrapperDigest: string;
  toolDigest: string | null;
  configDigests: Record<string, string>;
};

type NormalizedCommand = {
  name: string;
  bin: string | null;
  args: string[];
};

type PathState =
  | { kind: "file"; digest: string }
  | { kind: "directory"; digest: string }
  | { kind: "missing"; digest: null }
  | { kind: "other"; digest: string };

export type CheckProofReceipt = {
  schemaVersion: 2;
  artifact: "changed-check evidence receipt";
  status: "passed" | "failed" | "skipped";
  exitCode: number;
  ranTool: boolean;
  commandFamily: CommandFamily;
  fingerprint: string;
  requiredInputs: {
    repo: {
      remoteOrigin: string | null;
      worktreeRoot: string | null;
    };
    git: {
      baseRef: string | null;
      headRef: string | null;
      baseSha: string | null;
      headSha: string | null;
      mergeBaseSha: string | null;
      currentHead: string | null;
      currentTree: string | null;
    };
    changedPaths: {
      paths: string[];
      states: Record<string, PathState>;
    };
    plan: {
      summary: string;
      commands: NormalizedCommand[];
    };
    command: NormalizedCommand & {
      family: CommandFamily;
    };
    env: Record<string, string>;
    runtime: {
      platform: NodeJS.Platform;
      arch: string;
      node: string;
      modules: string;
      v8: string;
      execPathDigest: string | null;
    };
    invalidationInputs: Record<string, string | null>;
    expectedWrapperProof: WrapperProof | null;
  };
  observed: {
    wrapperProof: WrapperProof | null;
  };
};

type ReuseDecision =
  | { reusable: true; path: string; receipt: CheckProofReceipt; reason: string }
  | { reusable: false; path: string; reason: string };

const REUSABLE_ENV_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GOGC",
  "GOMEMLIMIT",
  "GOMAXPROCS",
  "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD",
  "OPENCLAW_HEAVY_CHECK_LOCK_SCOPE",
  "OPENCLAW_LOCAL_CHECK",
  "OPENCLAW_LOCAL_CHECK_MODE",
  "OPENCLAW_OXLINT_FORCE_LOCK",
  "OPENCLAW_OXLINT_SHARD_CONCURRENCY",
  "OPENCLAW_OXLINT_SHARDS_SERIAL",
  "OPENCLAW_OXLINT_SKIP_LOCK",
  "OPENCLAW_OXLINT_SKIP_PREPARE",
  "OPENCLAW_TSGO_BUILD_INFO_FILE",
  "OPENCLAW_TSGO_FORCE_LOCK",
  "OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD",
  "OPENCLAW_TSGO_SPARSE_SKIP",
].toSorted();

const TOOL_PROOF_ENV_KEY = "OPENCLAW_TOOL_PROOF_RECEIPT";
const CHECK_EVIDENCE_INPUT_PATHS = [
  ".oxlintrc.json",
  "config/oxlint/boundary-guards.json",
  "config/tsconfig/oxlint.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/changed-lanes.mjs",
  "scripts/changed-lanes.mts",
  "scripts/check-changed.mjs",
  "scripts/check-changed.mts",
  "scripts/lib/check-proof-reuse.mts",
  "scripts/lib/local-heavy-check-runtime.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/tsgo-sparse-guard.mts",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/run-oxlint-shards.mts",
  "scripts/run-oxlint.mjs",
  "scripts/run-oxlint.mts",
  "scripts/run-tsgo.mjs",
  "scripts/run-tsgo.mts",
].toSorted();

const digestMemo = new Map<string, string | null>();

export function createToolProofEnv(command: ProofCommand, receiptPath: string) {
  return {
    ...(command.env ?? process.env),
    [TOOL_PROOF_ENV_KEY]: receiptPath,
  };
}

export function writeWrapperProofReceipt(receiptPath: string | undefined, proof: WrapperProof) {
  if (!receiptPath) {
    return;
  }
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeJsonAtomic(receiptPath, proof);
}

export function readWrapperProofReceipt(receiptPath: string): WrapperProof | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    return isWrapperProof(parsed) &&
      parsed.status === "passed" &&
      parsed.exitCode === 0 &&
      parsed.ranTool === true
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function createWrapperProof(params: {
  tool: "tsgo" | "tsgolint";
  wrapper: string;
  argv: string[];
  status?: "passed" | "failed" | "skipped";
  exitCode?: number;
  ranTool?: boolean;
  extraConfigPaths?: string[];
  toolPath?: string;
  cwd?: string;
}) {
  const cwd = params.cwd ?? process.cwd();
  const toolPath = params.toolPath ?? toolBinaryPath(params.tool, cwd);
  const status = params.status ?? "passed";
  const exitCode = params.exitCode ?? (status === "passed" || status === "skipped" ? 0 : 1);
  const ranTool = params.ranTool ?? status === "passed";
  return {
    status,
    exitCode,
    ranTool,
    tool: params.tool,
    wrapper: normalizeRepoPath(params.wrapper, cwd),
    argv: [...params.argv],
    wrapperDigest: digestFileIfPresent(params.wrapper, cwd) ?? "",
    toolDigest: toolPath ? digestFileIfPresent(toolPath, cwd) : null,
    configDigests: digestConfigInputs(params.argv, cwd, params.extraConfigPaths),
  } satisfies WrapperProof;
}

export function commandFamily(command: ProofCommand): CommandFamily {
  const joined = [command.bin ?? "pnpm", ...command.args].join(" ");
  if (/\b(?:tsgo(?::|$)|run-tsgo\.mjs)\b/u.test(joined)) {
    return "tsgo";
  }
  if (/\b(?:run-oxlint(?:-shards)?\.mjs|run-oxlint-shards\.mts|oxlint)\b/u.test(joined)) {
    return "tsgolint";
  }
  return "other";
}

export function createExpectedWrapperProofForCommand(
  command: ProofCommand,
  cwd = process.cwd(),
): WrapperProof | null {
  const argv = [...command.args];
  const wrapper = argv[0];
  if (command.bin !== "node" || typeof wrapper !== "string") {
    return null;
  }
  if (wrapper === "scripts/run-tsgo.mjs" || wrapper === "scripts/run-tsgo.mts") {
    return createWrapperProof({
      tool: "tsgo",
      wrapper: wrapper.endsWith(".mjs") ? "scripts/run-tsgo.mts" : wrapper,
      argv: argv.slice(1),
      cwd,
    });
  }
  if (wrapper === "scripts/run-oxlint.mjs" || wrapper === "scripts/run-oxlint.mts") {
    return createWrapperProof({
      tool: "tsgolint",
      wrapper: wrapper.endsWith(".mjs") ? "scripts/run-oxlint.mts" : wrapper,
      argv: argv.slice(1),
      cwd,
    });
  }
  return null;
}

export function createCheckProofReceipt(params: {
  command: ProofCommand;
  context: ProofRunContext;
  exitCode: number;
  expectedWrapperProof?: WrapperProof | null;
  wrapperProof: WrapperProof | null;
}) {
  const cwd = params.context.cwd ?? process.cwd();
  const family =
    params.expectedWrapperProof?.tool ?? params.wrapperProof?.tool ?? commandFamily(params.command);
  const ranTool =
    params.wrapperProof?.ranTool === true &&
    params.wrapperProof.status === "passed" &&
    params.wrapperProof.exitCode === 0;
  const status =
    params.exitCode === 0 && ranTool ? "passed" : params.exitCode === 0 ? "skipped" : "failed";
  const requiredInputs = createRequiredInputs({
    command: params.command,
    context: params.context,
    cwd,
    expectedWrapperProof: params.expectedWrapperProof ?? params.wrapperProof,
    family,
  });
  const receiptWithoutFingerprint: CheckProofReceipt = {
    schemaVersion: 2,
    artifact: "changed-check evidence receipt",
    status,
    exitCode: params.exitCode,
    ranTool,
    commandFamily: family,
    fingerprint: "",
    requiredInputs,
    observed: {
      wrapperProof: params.wrapperProof,
    },
  };
  return {
    ...receiptWithoutFingerprint,
    fingerprint: sha256(stableStringify(requiredInputs)),
  };
}

export function isReusableCheckProofReceipt(receipt: unknown, expected: CheckProofReceipt) {
  if (!isCheckProofReceipt(receipt)) {
    return false;
  }
  const expectedWrapperProof = expected.requiredInputs.expectedWrapperProof;
  return (
    receipt.status === "passed" &&
    receipt.exitCode === 0 &&
    receipt.ranTool === true &&
    receipt.commandFamily === expected.commandFamily &&
    receipt.commandFamily !== "other" &&
    receipt.fingerprint === expected.fingerprint &&
    expectedWrapperProof !== null &&
    stableStringify(receipt.requiredInputs) === stableStringify(expected.requiredInputs) &&
    stableStringify(receipt.observed.wrapperProof) === stableStringify(expectedWrapperProof)
  );
}

export function evaluateReusableReceipt(
  receiptDir: string,
  expected: CheckProofReceipt,
): ReuseDecision {
  const candidatePath = path.join(receiptDir, `${expected.fingerprint}.json`);
  if (expected.commandFamily === "other" || expected.requiredInputs.expectedWrapperProof === null) {
    return {
      reusable: false,
      path: candidatePath,
      reason: "unsupported command family for changed-check evidence receipt reuse",
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    if (isReusableCheckProofReceipt(parsed, expected)) {
      return {
        reusable: true,
        path: candidatePath,
        receipt: parsed,
        reason: "exact-target evidence reuse",
      };
    }
    return {
      reusable: false,
      path: candidatePath,
      reason: describeReceiptRejection(parsed, expected),
    };
  } catch (error) {
    const code = isRecord(error) ? error.code : null;
    return {
      reusable: false,
      path: candidatePath,
      reason:
        code === "ENOENT"
          ? "missing changed-check evidence receipt"
          : "malformed changed-check evidence receipt",
    };
  }
}

export function readReusableReceipt(receiptDir: string, expected: CheckProofReceipt) {
  const decision = evaluateReusableReceipt(receiptDir, expected);
  return decision.reusable ? { path: decision.path, receipt: decision.receipt } : null;
}

export function writeCheckProofReceipt(receiptDir: string, receipt: CheckProofReceipt) {
  fs.mkdirSync(receiptDir, { recursive: true });
  writeJsonAtomic(path.join(receiptDir, `${receipt.fingerprint}.json`), receipt);
}

export function defaultCheckProofReceiptDir(cwd = process.cwd()) {
  return path.join(cwd, ".artifacts", "check-changed-receipts");
}

function createRequiredInputs(params: {
  command: ProofCommand;
  context: ProofRunContext;
  cwd: string;
  expectedWrapperProof: WrapperProof | null;
  family: CommandFamily;
}): CheckProofReceipt["requiredInputs"] {
  return {
    repo: {
      remoteOrigin: gitText(["config", "--get", "remote.origin.url"], params.cwd),
      worktreeRoot: gitText(["rev-parse", "--show-toplevel"], params.cwd),
    },
    git: {
      baseRef: params.context.base ?? null,
      headRef: params.context.head ?? null,
      baseSha: gitCommit(params.context.base, params.cwd),
      headSha: gitCommit(params.context.head, params.cwd),
      mergeBaseSha: gitMergeBase(params.context.base, params.context.head, params.cwd),
      currentHead: gitCommit("HEAD", params.cwd),
      currentTree: gitText(["rev-parse", "HEAD^{tree}"], params.cwd),
    },
    changedPaths: {
      paths: [...params.context.changedPaths].toSorted((left, right) => left.localeCompare(right)),
      states: changedPathStates(params.context.changedPaths, params.cwd),
    },
    plan: {
      summary: params.context.planSummary,
      commands: (params.context.planCommands ?? []).map(normalizeCommand),
    },
    command: {
      ...normalizeCommand(params.command),
      family: params.family,
    },
    env: selectedEnv(params.command.env ?? process.env),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      modules: process.versions.modules ?? "",
      v8: process.versions.v8 ?? "",
      execPathDigest: digestFileIfPresent(process.execPath, params.cwd),
    },
    invalidationInputs: digestNamedInputs(params.cwd),
    expectedWrapperProof: params.expectedWrapperProof,
  };
}

function isCheckProofReceipt(value: unknown): value is CheckProofReceipt {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    value.artifact === "changed-check evidence receipt" &&
    (value.status === "passed" || value.status === "failed" || value.status === "skipped") &&
    typeof value.exitCode === "number" &&
    typeof value.ranTool === "boolean" &&
    typeof value.fingerprint === "string" &&
    (value.commandFamily === "tsgo" ||
      value.commandFamily === "tsgolint" ||
      value.commandFamily === "other") &&
    isRecord(value.requiredInputs) &&
    isRecord(value.observed)
  );
}

function isWrapperProof(value: unknown): value is WrapperProof {
  return (
    isRecord(value) &&
    (value.status === "passed" || value.status === "failed" || value.status === "skipped") &&
    typeof value.exitCode === "number" &&
    typeof value.ranTool === "boolean" &&
    (value.tool === "tsgo" || value.tool === "tsgolint") &&
    typeof value.wrapper === "string" &&
    Array.isArray(value.argv) &&
    value.argv.every((arg) => typeof arg === "string") &&
    typeof value.wrapperDigest === "string" &&
    (typeof value.toolDigest === "string" || value.toolDigest === null) &&
    isRecord(value.configDigests) &&
    Object.values(value.configDigests).every((digest) => typeof digest === "string")
  );
}

function normalizeCommand(command: ProofCommand): NormalizedCommand {
  return {
    name: command.name,
    bin: command.bin ?? null,
    args: [...command.args],
  };
}

function digestConfigInputs(argv: string[], cwd: string, extraConfigPaths: string[] = []) {
  const configs = new Set<string>(extraConfigPaths);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      (arg === "-p" || arg === "--project" || arg === "--tsconfig" || arg === "--config") &&
      argv[index + 1]
    ) {
      configs.add(argv[index + 1]);
    } else if (arg?.startsWith("--project=")) {
      configs.add(arg.slice("--project=".length));
    } else if (arg?.startsWith("--tsconfig=")) {
      configs.add(arg.slice("--tsconfig=".length));
    } else if (arg?.startsWith("--config=")) {
      configs.add(arg.slice("--config=".length));
    }
  }
  const digests: Record<string, string> = {};
  for (const config of [...collectConfigClosure([...configs], cwd)].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const digest = digestFileIfPresent(config, cwd);
    if (digest) {
      digests[normalizeRepoPath(config, cwd)] = digest;
    }
  }
  return digests;
}

function selectedEnv(env: NodeJS.ProcessEnv) {
  const selected: Record<string, string> = {};
  for (const key of REUSABLE_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") {
      selected[key] = value;
    }
  }
  return selected;
}

function changedPathStates(paths: string[], cwd: string) {
  const states: Record<string, PathState> = {};
  for (const changedPath of [...new Set(paths)].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    states[changedPath] = pathState(changedPath, cwd);
  }
  return states;
}

function pathState(candidate: string, cwd: string): PathState {
  const absolute = path.resolve(cwd, candidate);
  try {
    const stats = fs.statSync(absolute);
    if (stats.isFile()) {
      return { kind: "file", digest: sha256(fs.readFileSync(absolute)) };
    }
    if (stats.isDirectory()) {
      return { kind: "directory", digest: sha256(directoryListing(absolute)) };
    }
    return { kind: "other", digest: sha256(`${stats.mode}:${stats.size}:${stats.mtimeMs}`) };
  } catch {
    return { kind: "missing", digest: null };
  }
}

function directoryListing(absolute: string) {
  try {
    return fs
      .readdirSync(absolute)
      .toSorted((left, right) => left.localeCompare(right))
      .join("\n");
  } catch {
    return "";
  }
}

function digestNamedInputs(cwd: string) {
  const digests: Record<string, string | null> = {};
  for (const inputPath of CHECK_EVIDENCE_INPUT_PATHS) {
    digests[inputPath] = digestFileIfPresent(inputPath, cwd);
  }
  return digests;
}

function describeReceiptRejection(receipt: unknown, expected: CheckProofReceipt) {
  if (!isRecord(receipt)) {
    return "malformed changed-check evidence receipt";
  }
  if (receipt.schemaVersion !== 2 || receipt.artifact !== "changed-check evidence receipt") {
    return "current-schema changed-check evidence receipt not found";
  }
  if (receipt.status !== "passed" || receipt.exitCode !== 0 || receipt.ranTool !== true) {
    return "changed-check evidence receipt did not pass with ranTool=true";
  }
  if (receipt.commandFamily !== expected.commandFamily || receipt.commandFamily === "other") {
    return "changed-check evidence receipt command family mismatch";
  }
  if (receipt.fingerprint !== expected.fingerprint) {
    return "changed-check evidence SHA mismatch";
  }
  if (!isRecord(receipt.observed) || !isWrapperProof(receipt.observed.wrapperProof)) {
    return "changed-check evidence receipt lacks native wrapper proof";
  }
  return "changed-check evidence receipt required inputs mismatch";
}

function collectConfigClosure(configs: string[], cwd: string) {
  const seen = new Set<string>();
  const pending = configs.map((config) => resolveConfigPath(config, cwd));
  while (pending.length > 0) {
    const configPath = pending.pop();
    if (!configPath || seen.has(configPath)) {
      continue;
    }
    seen.add(configPath);
    const parsed = readJsoncObject(configPath);
    if (!parsed) {
      continue;
    }
    const extendsValue = parsed.extends;
    const extendsPaths = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
    for (const extendsPath of extendsPaths) {
      if (typeof extendsPath === "string") {
        const resolved = resolveExtendsPath(extendsPath, configPath, cwd);
        if (resolved) {
          pending.push(resolved);
        }
      }
    }
    if (Array.isArray(parsed.references)) {
      for (const reference of parsed.references) {
        if (isRecord(reference) && typeof reference.path === "string") {
          pending.push(resolveConfigPath(path.join(path.dirname(configPath), reference.path), cwd));
        }
      }
    }
  }
  return seen;
}

function resolveConfigPath(candidate: string, cwd: string) {
  const absolute = path.resolve(cwd, candidate);
  if (fs.existsSync(absolute)) {
    const stats = fs.statSync(absolute);
    return stats.isDirectory() ? path.join(absolute, "tsconfig.json") : absolute;
  }
  if (!path.extname(absolute) && fs.existsSync(`${absolute}.json`)) {
    return `${absolute}.json`;
  }
  return absolute;
}

function resolveExtendsPath(extendsPath: string, configPath: string, cwd: string) {
  if (!extendsPath.startsWith(".") && !path.isAbsolute(extendsPath)) {
    return null;
  }
  return resolveConfigPath(path.resolve(path.dirname(configPath), extendsPath), cwd);
}

function readJsoncObject(filePath: string) {
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(filePath, "utf8")));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripJsonComments(source: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/gu, "$1");
}

function normalizeRepoPath(candidate: string, cwd: string) {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : absolute;
}

function digestFileIfPresent(candidate: string, cwd: string) {
  const absolute = path.resolve(cwd, candidate);
  const cached = digestMemo.get(absolute);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const digest = sha256(fs.readFileSync(absolute));
    digestMemo.set(absolute, digest);
    return digest;
  } catch {
    digestMemo.set(absolute, null);
    return null;
  }
}

function toolBinaryPath(tool: "tsgo" | "tsgolint", cwd: string) {
  const binName = tool === "tsgo" ? "tsgo" : "oxlint";
  return path.join(cwd, "node_modules", ".bin", binName);
}

function gitCommit(ref: string | undefined, cwd: string) {
  if (!ref) {
    return null;
  }
  return gitSha(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
}

function gitMergeBase(base: string | undefined, head: string | undefined, cwd: string) {
  if (!base || !head) {
    return null;
  }
  return gitSha(["merge-base", base, head], cwd);
}

function gitSha(args: string[], cwd: string) {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function gitText(args: string[], cwd: string) {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function writeJsonAtomic(target: string, value: unknown) {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}
