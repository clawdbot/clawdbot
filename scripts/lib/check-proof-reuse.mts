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
  schemaVersion: 3;
  artifact: "changed-check evidence receipt";
  status: "passed" | "failed" | "skipped";
  exitCode: number;
  ranTool: boolean;
  commandFamily: CommandFamily;
  fingerprint: string;
  requiredInputs: {
    repo: {
      remoteOrigin: string | null;
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
  producer: {
    worktreeRoot: string | null;
  };
};

export type CheckProofReceiptBundle = {
  schemaVersion: 1;
  artifact: "changed-check evidence receipt bundle";
  digest: string;
  receipts: CheckProofReceipt[];
};

type ReuseDecision =
  | { reusable: true; path: string; receipt: CheckProofReceipt; reason: string }
  | { reusable: false; path: string; reason: string };

export type DescendantProofPlan = {
  commands: ProofCommand[];
  lanesAll: boolean;
  releaseMetadataOnly: boolean;
};

export type DescendantProofReuseOptions = {
  cwd?: string;
  createDescendantPlan: (params: {
    currentHead: string;
    paths: string[];
    producerHead: string;
  }) => DescendantProofPlan | null;
};

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
const DESCENDANT_RECEIPT_SCAN_LIMIT = 512;
export const CHECK_PROOF_BUNDLE_MAX_RECEIPTS = 64;
export const CHECK_PROOF_BUNDLE_MAX_BYTES = 64 * 1024;
const CHECK_PROOF_BUNDLE_MAX_STRING_BYTES = 4096;
const CHECK_PROOF_BUNDLE_MAX_ARRAY_LENGTH = 256;
const CHECK_PROOF_BUNDLE_MAX_OBJECT_KEYS = 256;
const CHECK_PROOF_BUNDLE_MAX_DEPTH = 32;
const CHECK_PROOF_BUNDLE_MAX_NODES = 10_000;
const CHECK_PROOF_ARTIFACT_TARBALL_MAX_BYTES = 1024 * 1024;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const RELEASE_METADATA_INVALIDATION_EXCEPTIONS = new Set(["package.json"]);

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
    schemaVersion: 3,
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
    producer: {
      worktreeRoot: gitText(["rev-parse", "--show-toplevel"], cwd),
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
  descendantOptions?: DescendantProofReuseOptions,
): ReuseDecision {
  const candidatePath = path.join(receiptDir, `${expected.fingerprint}.json`);
  const cwd = descendantOptions?.cwd ?? expected.producer.worktreeRoot ?? process.cwd();
  if (expected.commandFamily === "other" || expected.requiredInputs.expectedWrapperProof === null) {
    return {
      reusable: false,
      path: candidatePath,
      reason: "unsupported command family for changed-check evidence receipt reuse",
    };
  }
  if (!gitWorktreeClean(cwd)) {
    return {
      reusable: false,
      path: candidatePath,
      reason: "current worktree has dirty or untracked files",
    };
  }
  const exactDecision = evaluateExactReceipt(candidatePath, expected);
  if (
    exactDecision.reusable ||
    exactDecision.reason !== "missing changed-check evidence receipt" ||
    !descendantOptions
  ) {
    return exactDecision;
  }
  return evaluateDescendantReceipts(receiptDir, expected, descendantOptions) ?? exactDecision;
}

function evaluateExactReceipt(candidatePath: string, expected: CheckProofReceipt): ReuseDecision {
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

function evaluateDescendantReceipts(
  receiptDir: string,
  expected: CheckProofReceipt,
  options: DescendantProofReuseOptions,
): ReuseDecision | null {
  const receiptPaths = listAtomicReceiptPaths(receiptDir);
  if (typeof receiptPaths === "string") {
    return {
      reusable: false,
      path: path.join(receiptDir, `${expected.fingerprint}.json`),
      reason: receiptPaths,
    };
  }
  let firstRejected: ReuseDecision | null = null;
  let malformedCandidates = 0;
  for (const receiptPath of receiptPaths) {
    const parsed = readSchemaValidReceipt(receiptPath);
    if (!parsed) {
      malformedCandidates += 1;
      continue;
    }
    if (!sameReceiptCommand(parsed, expected)) {
      continue;
    }
    const decision = evaluateDescendantReceiptCandidate(receiptPath, parsed, expected, options);
    if (decision.reusable) {
      return decision;
    }
    firstRejected ??= decision;
  }
  return (
    firstRejected ??
    (malformedCandidates > 0
      ? rejected(
          path.join(receiptDir, `${expected.fingerprint}.json`),
          "no reusable changed-check evidence receipt found after skipping malformed candidates",
        )
      : null)
  );
}

function listAtomicReceiptPaths(receiptDir: string) {
  try {
    const names = fs
      .readdirSync(receiptDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .toSorted((left, right) => left.localeCompare(right));
    if (names.length > DESCENDANT_RECEIPT_SCAN_LIMIT) {
      return "too many changed-check evidence receipts to scan";
    }
    return names.map((name) => path.join(receiptDir, name));
  } catch (error) {
    const code = isRecord(error) ? error.code : null;
    return code === "ENOENT" ? [] : "changed-check evidence receipt scan failed";
  }
}

function readSchemaValidReceipt(receiptPath: string): CheckProofReceipt | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    return isCheckProofReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function evaluateDescendantReceiptCandidate(
  receiptPath: string,
  receipt: CheckProofReceipt,
  expected: CheckProofReceipt,
  options: DescendantProofReuseOptions,
): ReuseDecision {
  const expectedWrapperProof = expected.requiredInputs.expectedWrapperProof;
  if (receipt.status !== "passed" || receipt.exitCode !== 0 || receipt.ranTool !== true) {
    return rejected(receiptPath, "changed-check evidence receipt did not pass with ranTool=true");
  }
  if (!expectedWrapperProof || receipt.commandFamily !== expected.commandFamily) {
    return rejected(receiptPath, "changed-check evidence receipt command family mismatch");
  }
  if (
    stableStringify(receipt.requiredInputs.expectedWrapperProof) !==
      stableStringify(expectedWrapperProof) ||
    stableStringify(receipt.observed.wrapperProof) !== stableStringify(expectedWrapperProof)
  ) {
    return rejected(
      receiptPath,
      "changed-check evidence receipt lacks matching native wrapper proof",
    );
  }
  const producerHead = fullGitSha(receipt.requiredInputs.git.currentHead);
  const currentHead = fullGitSha(expected.requiredInputs.git.currentHead);
  if (!producerHead || !currentHead) {
    return rejected(receiptPath, "changed-check evidence receipt has unresolved git head");
  }
  if (producerHead === currentHead) {
    return rejected(receiptPath, "missing exact-target changed-check evidence receipt");
  }
  const cwd = options.cwd ?? process.cwd();
  const ancestor = gitIsAncestor(producerHead, currentHead, cwd);
  if (ancestor === "unknown") {
    return rejected(receiptPath, "changed-check evidence ancestry unresolved");
  }
  if (ancestor === "no") {
    return rejected(
      receiptPath,
      "changed-check evidence producer is not an ancestor of current HEAD",
    );
  }
  if (!gitWorktreeClean(cwd)) {
    return rejected(receiptPath, "current worktree has dirty or untracked files");
  }
  const descendantPaths = gitChangedPathsBetween(producerHead, currentHead, cwd);
  if (!descendantPaths) {
    return rejected(receiptPath, "changed-check evidence descendant range unresolved");
  }
  if (descendantPaths.length === 0) {
    return rejected(receiptPath, "missing exact-target changed-check evidence receipt");
  }
  const descendantPlan = options.createDescendantPlan({
    currentHead,
    paths: descendantPaths,
    producerHead,
  });
  if (!descendantPlan) {
    return rejected(receiptPath, "changed-check descendant plan unresolved");
  }
  if (descendantPlan.lanesAll) {
    return rejected(receiptPath, "descendant changed-check delta requires full proof");
  }
  const stableMismatch = describeDescendantStableMismatch(receipt, expected, descendantPlan);
  if (stableMismatch) {
    return rejected(receiptPath, stableMismatch);
  }
  const changedPathMismatch = describeDescendantPathMismatch(receipt, expected, descendantPaths);
  if (changedPathMismatch) {
    return rejected(receiptPath, changedPathMismatch);
  }
  const affectedCommand = descendantPlan.commands.find((command) =>
    sameNormalizedCommand(normalizeCommand(command), expected.requiredInputs.command),
  );
  if (affectedCommand) {
    return rejected(receiptPath, `descendant changed-check plan includes ${affectedCommand.name}`);
  }
  return {
    reusable: true,
    path: receiptPath,
    receipt,
    reason: "descendant-safe evidence reuse",
  };
}

function rejected(path: string, reason: string): ReuseDecision {
  return { reusable: false, path, reason };
}

export function readReusableReceipt(receiptDir: string, expected: CheckProofReceipt) {
  const decision = evaluateReusableReceipt(receiptDir, expected);
  return decision.reusable ? { path: decision.path, receipt: decision.receipt } : null;
}

export function writeCheckProofReceipt(receiptDir: string, receipt: CheckProofReceipt) {
  fs.mkdirSync(receiptDir, { recursive: true });
  if (!isDurablePassedReceipt(receipt)) {
    writeReceiptDiagnostic(receiptDir, receipt);
    return { installed: false, reason: "non-reusable receipt" };
  }
  const target = path.join(receiptDir, `${receipt.fingerprint}.json`);
  const lockPath = path.join(receiptDir, ".install.lock");
  let lock: number | null = null;
  try {
    lock = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const code = isRecord(error) ? error.code : null;
    if (code !== "EEXIST") {
      writeReceiptDiagnostic(receiptDir, receipt);
    }
    return { installed: false, reason: "receipt store busy" };
  }
  try {
    const existing = readSchemaValidReceipt(target);
    if (
      existing &&
      existing.fingerprint === receipt.fingerprint &&
      isDurablePassedReceipt(existing)
    ) {
      return { installed: false, reason: "existing reusable receipt kept" };
    }
    writeJsonAtomic(target, receipt);
    return { installed: true, reason: "installed reusable receipt" };
  } finally {
    if (lock !== null) {
      fs.closeSync(lock);
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // A missing lock is recoverable; the durable receipt write already finished.
    }
  }
}

export function createCheckProofReceiptBundleFromDir(receiptDir: string) {
  return createCheckProofReceiptBundle(selectNewestUsableReceipts(receiptDir));
}

export function createCheckProofReceiptBundle(receipts: CheckProofReceipt[]) {
  const bounded = receipts.filter(isDurablePassedReceipt).slice(0, CHECK_PROOF_BUNDLE_MAX_RECEIPTS);
  while (bounded.length > 0) {
    const bundle = withBundleDigest({
      schemaVersion: 1,
      artifact: "changed-check evidence receipt bundle",
      receipts: bounded,
    });
    if (Buffer.byteLength(stableStringify(bundle), "utf8") <= CHECK_PROOF_BUNDLE_MAX_BYTES) {
      return bundle;
    }
    bounded.pop();
  }
  return withBundleDigest({
    schemaVersion: 1,
    artifact: "changed-check evidence receipt bundle",
    receipts: [],
  });
}

export function encodeCheckProofReceiptBundleForEnv(receiptDir: string) {
  const bundle = createCheckProofReceiptBundleFromDir(receiptDir);
  if (bundle.receipts.length === 0) {
    return null;
  }
  const encoded = stableStringify(bundle);
  if (Buffer.byteLength(encoded, "utf8") > CHECK_PROOF_BUNDLE_MAX_BYTES) {
    return null;
  }
  return Buffer.from(encoded, "utf8").toString("base64");
}

export function decodeCheckProofReceiptBundleFromEnv(value: string | undefined) {
  if (!value) {
    return { ok: false as const, reason: "missing bundle" };
  }
  const compact = value.trim();
  if (
    compact.length === 0 ||
    compact.length > Math.ceil(CHECK_PROOF_BUNDLE_MAX_BYTES / 3) * 4 + 4 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)
  ) {
    return { ok: false as const, reason: "malformed bundle encoding" };
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(compact, "base64");
  } catch {
    return { ok: false as const, reason: "malformed bundle encoding" };
  }
  if (decoded.byteLength > CHECK_PROOF_BUNDLE_MAX_BYTES) {
    return { ok: false as const, reason: "oversized bundle" };
  }
  return parseCheckProofReceiptBundle(decoded.toString("utf8"));
}

export function writeCheckProofReceiptBundleFileAtomic(
  target: string,
  receiptDir: string,
): CheckProofReceiptBundle {
  const bundle = createCheckProofReceiptBundleFromDir(receiptDir);
  validateRemoteProofExportPath(target);
  const encoded = stableStringify(bundle);
  if (Buffer.byteLength(encoded, "utf8") > CHECK_PROOF_BUNDLE_MAX_BYTES) {
    throw new Error("changed-check proof export bundle exceeds size bound");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeJsonAtomic(target, bundle);
  return bundle;
}

export function importCheckProofReceiptBundle(receiptDir: string, bundle: CheckProofReceiptBundle) {
  const validation = validateCheckProofReceiptBundle(bundle);
  if (!validation.ok) {
    return { imported: 0, reason: validation.reason };
  }
  let imported = 0;
  for (const receipt of validation.bundle.receipts) {
    const result = writeCheckProofReceipt(receiptDir, receipt);
    if (result.installed) {
      imported += 1;
    }
  }
  return { imported, reason: "imported reusable receipts" };
}

export function readCheckProofReceiptBundleFromArtifactTarball(
  tarballPath: string,
  expectedMember: string,
) {
  validateRemoteProofExportPath(expectedMember);
  const stat = fs.statSync(tarballPath);
  if (!stat.isFile() || stat.size > CHECK_PROOF_ARTIFACT_TARBALL_MAX_BYTES) {
    throw new Error("changed-check proof artifact tarball is missing or oversized");
  }
  const members = tarList(tarballPath);
  if (members.length !== 1 || members[0] !== expectedMember || !safeTarMember(members[0])) {
    throw new Error("changed-check proof artifact tarball member mismatch");
  }
  const verbose = tarVerboseList(tarballPath);
  if (verbose.length !== 1 || !verbose[0]?.startsWith("-")) {
    throw new Error("changed-check proof artifact tarball member is not a regular file");
  }
  const decoded = execFileSync("tar", ["-xOf", tarballPath, expectedMember], {
    encoding: "utf8",
    maxBuffer: CHECK_PROOF_BUNDLE_MAX_BYTES + 1,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (Buffer.byteLength(decoded, "utf8") > CHECK_PROOF_BUNDLE_MAX_BYTES) {
    throw new Error("changed-check proof artifact member exceeds size bound");
  }
  const parsed = parseCheckProofReceiptBundle(decoded);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.bundle;
}

function selectNewestUsableReceipts(receiptDir: string) {
  const receiptPaths = listAtomicReceiptPaths(receiptDir);
  if (typeof receiptPaths === "string") {
    return [];
  }
  const candidates = receiptPaths
    .map((receiptPath) => {
      const receipt = readSchemaValidReceipt(receiptPath);
      if (!receipt || !receiptFilenameMatchesFingerprint(receiptPath, receipt)) {
        return null;
      }
      if (!isDurablePassedReceipt(receipt)) {
        return null;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(receiptPath).mtimeMs;
      } catch {
        return null;
      }
      return { path: receiptPath, receipt, key: receiptCommandKey(receipt), mtimeMs };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .toSorted(
      (left, right) =>
        right.mtimeMs - left.mtimeMs ||
        left.path.localeCompare(right.path) ||
        left.receipt.fingerprint.localeCompare(right.receipt.fingerprint),
    );
  const selected = new Map<string, CheckProofReceipt>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.key)) {
      selected.set(candidate.key, candidate.receipt);
    }
    if (selected.size >= CHECK_PROOF_BUNDLE_MAX_RECEIPTS) {
      break;
    }
  }
  return [...selected.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, receipt]) => receipt);
}

function parseCheckProofReceiptBundle(source: string) {
  if (Buffer.byteLength(source, "utf8") > CHECK_PROOF_BUNDLE_MAX_BYTES) {
    return { ok: false as const, reason: "oversized changed-check proof bundle" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false as const, reason: "malformed changed-check proof bundle" };
  }
  const bounded = validateBoundedJsonValue(parsed);
  if (!bounded.ok) {
    return { ok: false as const, reason: bounded.reason };
  }
  return validateCheckProofReceiptBundle(parsed);
}

function validateCheckProofReceiptBundle(value: unknown) {
  if (!isRecord(value)) {
    return { ok: false as const, reason: "malformed changed-check proof bundle" };
  }
  const keys = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  if (
    stableStringify(keys) !== stableStringify(["artifact", "digest", "receipts", "schemaVersion"])
  ) {
    return { ok: false as const, reason: "changed-check proof bundle shape mismatch" };
  }
  if (
    value.schemaVersion !== 1 ||
    value.artifact !== "changed-check evidence receipt bundle" ||
    typeof value.digest !== "string" ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > CHECK_PROOF_BUNDLE_MAX_RECEIPTS
  ) {
    return { ok: false as const, reason: "changed-check proof bundle schema mismatch" };
  }
  const bundle = value as CheckProofReceiptBundle;
  const expectedDigest = bundleDigest({
    schemaVersion: bundle.schemaVersion,
    artifact: bundle.artifact,
    receipts: bundle.receipts,
  });
  if (bundle.digest !== expectedDigest) {
    return { ok: false as const, reason: "changed-check proof bundle digest mismatch" };
  }
  const seenFingerprints = new Set<string>();
  const seenCommands = new Set<string>();
  for (const receipt of bundle.receipts) {
    if (!isDurablePassedReceipt(receipt)) {
      return {
        ok: false as const,
        reason: "changed-check proof bundle contains non-proof receipt",
      };
    }
    const commandKey = receiptCommandKey(receipt);
    if (seenFingerprints.has(receipt.fingerprint) || seenCommands.has(commandKey)) {
      return { ok: false as const, reason: "changed-check proof bundle contains duplicates" };
    }
    seenFingerprints.add(receipt.fingerprint);
    seenCommands.add(commandKey);
  }
  return { ok: true as const, bundle };
}

function withBundleDigest(
  payload: Omit<CheckProofReceiptBundle, "digest">,
): CheckProofReceiptBundle {
  return {
    ...payload,
    digest: bundleDigest(payload),
  };
}

function bundleDigest(payload: Omit<CheckProofReceiptBundle, "digest">) {
  return sha256(stableStringify(payload));
}

function validateBoundedJsonValue(value: unknown) {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > CHECK_PROOF_BUNDLE_MAX_NODES) {
      return "changed-check proof bundle has too many nodes";
    }
    if (depth > CHECK_PROOF_BUNDLE_MAX_DEPTH) {
      return "changed-check proof bundle exceeds depth bound";
    }
    if (typeof entry === "string") {
      return Buffer.byteLength(entry, "utf8") > CHECK_PROOF_BUNDLE_MAX_STRING_BYTES
        ? "changed-check proof bundle string exceeds size bound"
        : null;
    }
    if (entry === null || typeof entry === "number" || typeof entry === "boolean") {
      return null;
    }
    if (Array.isArray(entry)) {
      if (entry.length > CHECK_PROOF_BUNDLE_MAX_ARRAY_LENGTH) {
        return "changed-check proof bundle array exceeds count bound";
      }
      for (const child of entry) {
        const reason = visit(child, depth + 1);
        if (reason) {
          return reason;
        }
      }
      return null;
    }
    if (!isRecord(entry)) {
      return "changed-check proof bundle contains unsupported JSON value";
    }
    const objectKeys = Object.keys(entry);
    if (objectKeys.length > CHECK_PROOF_BUNDLE_MAX_OBJECT_KEYS) {
      return "changed-check proof bundle object exceeds key bound";
    }
    for (const key of objectKeys) {
      if (Buffer.byteLength(key, "utf8") > CHECK_PROOF_BUNDLE_MAX_STRING_BYTES) {
        return "changed-check proof bundle key exceeds size bound";
      }
      const reason = visit(entry[key], depth + 1);
      if (reason) {
        return reason;
      }
    }
    return null;
  };
  const reason = visit(value, 0);
  return reason ? { ok: false as const, reason } : { ok: true as const };
}

function isDurablePassedReceipt(receipt: unknown): receipt is CheckProofReceipt {
  if (!isCheckProofReceipt(receipt)) {
    return false;
  }
  const expectedWrapperProof = receipt.requiredInputs.expectedWrapperProof;
  return (
    receipt.status === "passed" &&
    receipt.exitCode === 0 &&
    receipt.ranTool === true &&
    receipt.commandFamily !== "other" &&
    receipt.requiredInputs.command.family === receipt.commandFamily &&
    expectedWrapperProof !== null &&
    receipt.fingerprint === receiptFingerprint(receipt) &&
    stableStringify(receipt.observed.wrapperProof) === stableStringify(expectedWrapperProof)
  );
}

function receiptFingerprint(receipt: CheckProofReceipt) {
  return sha256(stableStringify(receipt.requiredInputs));
}

function receiptFilenameMatchesFingerprint(receiptPath: string, receipt: CheckProofReceipt) {
  return path.basename(receiptPath) === `${receipt.fingerprint}.json`;
}

function receiptCommandKey(receipt: CheckProofReceipt) {
  const command = receipt.requiredInputs.command;
  return stableStringify({
    family: receipt.commandFamily,
    name: command.name,
    bin: command.bin,
    args: command.args,
  });
}

function writeReceiptDiagnostic(receiptDir: string, receipt: CheckProofReceipt) {
  const fingerprint =
    typeof receipt.fingerprint === "string" && /^[0-9a-f]{64}$/u.test(receipt.fingerprint)
      ? receipt.fingerprint
      : sha256(stableStringify(receipt));
  const diagnosticDir = path.join(receiptDir, "diagnostics");
  fs.mkdirSync(diagnosticDir, { recursive: true });
  writeJsonAtomic(
    path.join(diagnosticDir, `${fingerprint}-${process.pid}-${Date.now()}.json`),
    receipt,
  );
}

function validateRemoteProofExportPath(candidate: string) {
  const normalized = candidate.replaceAll("\\", "/");
  if (
    candidate !== normalized ||
    path.isAbsolute(normalized) ||
    normalized.includes("\0") ||
    normalized.includes("..") ||
    !/^\.artifacts\/check-changed-proof-export\/[A-Za-z0-9_-]+\.json$/u.test(normalized)
  ) {
    throw new Error("unsafe changed-check proof export path");
  }
}

function tarList(tarballPath: string) {
  return execFileSync("tar", ["-tf", tarballPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function tarVerboseList(tarballPath: string) {
  return execFileSync("tar", ["-tvf", tarballPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeTarMember(member: string) {
  return (
    member === member.replaceAll("\\", "/") &&
    !member.startsWith("/") &&
    !member.startsWith("./") &&
    !member.includes("\0") &&
    !member.split("/").includes("..")
  );
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

function sameReceiptCommand(receipt: CheckProofReceipt, expected: CheckProofReceipt) {
  return (
    receipt.commandFamily === expected.commandFamily &&
    sameNormalizedCommand(receipt.requiredInputs.command, expected.requiredInputs.command)
  );
}

function sameNormalizedCommand(left: NormalizedCommand, right: NormalizedCommand) {
  return (
    left.name === right.name &&
    left.bin === right.bin &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index])
  );
}

function describeDescendantStableMismatch(
  receipt: CheckProofReceipt,
  expected: CheckProofReceipt,
  descendantPlan: DescendantProofPlan,
) {
  if (
    stableStringify(receipt.requiredInputs.repo) !== stableStringify(expected.requiredInputs.repo)
  ) {
    return "changed-check evidence repo identity mismatch";
  }
  const receiptGit = receipt.requiredInputs.git;
  const expectedGit = expected.requiredInputs.git;
  if (
    receiptGit.baseRef !== expectedGit.baseRef ||
    !sameFullSha(receiptGit.baseSha, expectedGit.baseSha) ||
    !sameFullSha(receiptGit.mergeBaseSha, expectedGit.mergeBaseSha)
  ) {
    return "changed-check evidence base or merge-base mismatch";
  }
  if (
    stableStringify(receipt.requiredInputs.env) !== stableStringify(expected.requiredInputs.env)
  ) {
    return "changed-check evidence environment mismatch";
  }
  if (
    stableStringify(receipt.requiredInputs.runtime) !==
    stableStringify(expected.requiredInputs.runtime)
  ) {
    return "changed-check evidence runtime or toolchain mismatch";
  }
  const changedInvalidationInput = firstChangedInvalidationInput(
    receipt.requiredInputs.invalidationInputs,
    expected.requiredInputs.invalidationInputs,
    descendantPlan,
  );
  if (changedInvalidationInput) {
    return `changed-check evidence owner input changed: ${changedInvalidationInput}`;
  }
  return null;
}

function firstChangedInvalidationInput(
  receiptInputs: Record<string, string | null>,
  expectedInputs: Record<string, string | null>,
  descendantPlan: DescendantProofPlan,
) {
  const keys = [
    ...new Set([...Object.keys(receiptInputs), ...Object.keys(expectedInputs)]),
  ].toSorted((left, right) => left.localeCompare(right));
  for (const key of keys) {
    if (
      receiptInputs[key] !== expectedInputs[key] &&
      !(descendantPlan.releaseMetadataOnly && RELEASE_METADATA_INVALIDATION_EXCEPTIONS.has(key))
    ) {
      return key;
    }
  }
  return null;
}

function describeDescendantPathMismatch(
  receipt: CheckProofReceipt,
  expected: CheckProofReceipt,
  descendantPaths: string[],
) {
  const producerPaths = new Set(receipt.requiredInputs.changedPaths.paths);
  const descendantPathSet = new Set(descendantPaths);
  for (const producerPath of receipt.requiredInputs.changedPaths.paths) {
    if (
      stableStringify(receipt.requiredInputs.changedPaths.states[producerPath]) !==
      stableStringify(expected.requiredInputs.changedPaths.states[producerPath])
    ) {
      return "changed-check evidence producer path state changed";
    }
  }
  for (const currentPath of expected.requiredInputs.changedPaths.paths) {
    if (!producerPaths.has(currentPath) && !descendantPathSet.has(currentPath)) {
      return "current changed paths include uncommitted or unresolved worktree state";
    }
  }
  return null;
}

function fullGitSha(value: string | null) {
  return typeof value === "string" && FULL_GIT_SHA_RE.test(value) ? value : null;
}

function sameFullSha(left: string | null, right: string | null) {
  return fullGitSha(left) !== null && left === right;
}

function gitIsAncestor(producerHead: string, currentHead: string, cwd: string) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", producerHead, currentHead], {
      cwd,
      stdio: "ignore",
    });
    return "yes" as const;
  } catch (error) {
    const status = isRecord(error) && typeof error.status === "number" ? error.status : null;
    return status === 1 ? ("no" as const) : ("unknown" as const);
  }
}

function gitWorktreeClean(cwd: string) {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return status
      .split("\n")
      .filter(Boolean)
      .every((line) => isProofStoreStatusPath(line.slice(3).replace(/^"|"$/gu, "")));
  } catch {
    return false;
  }
}

function isProofStoreStatusPath(statusPath: string) {
  const normalized = statusPath.replaceAll("\\", "/");
  return (
    normalized.startsWith(".artifacts/check-changed-receipts/") ||
    normalized.startsWith(".artifacts/check-changed-remote-proof-staging/") ||
    normalized.startsWith(".artifacts/check-changed-proof-export/") ||
    normalized.startsWith(".crabbox/")
  );
}

function gitChangedPathsBetween(producerHead: string, currentHead: string, cwd: string) {
  try {
    return execFileSync("git", ["diff", "--name-only", `${producerHead}..${currentHead}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .map((entry) => entry.trim().replaceAll("\\", "/"))
      .filter(Boolean)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
}

function isCheckProofReceipt(value: unknown): value is CheckProofReceipt {
  return (
    isRecord(value) &&
    value.schemaVersion === 3 &&
    value.artifact === "changed-check evidence receipt" &&
    (value.status === "passed" || value.status === "failed" || value.status === "skipped") &&
    typeof value.exitCode === "number" &&
    typeof value.ranTool === "boolean" &&
    typeof value.fingerprint === "string" &&
    (value.commandFamily === "tsgo" ||
      value.commandFamily === "tsgolint" ||
      value.commandFamily === "other") &&
    isRequiredInputs(value.requiredInputs) &&
    isRecord(value.observed) &&
    (value.observed.wrapperProof === null || isWrapperProof(value.observed.wrapperProof)) &&
    isRecord(value.producer) &&
    (typeof value.producer.worktreeRoot === "string" || value.producer.worktreeRoot === null)
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

function isRequiredInputs(value: unknown): value is CheckProofReceipt["requiredInputs"] {
  return (
    isRecord(value) &&
    isRecord(value.repo) &&
    (typeof value.repo.remoteOrigin === "string" || value.repo.remoteOrigin === null) &&
    isRecord(value.git) &&
    isNullableString(value.git.baseRef) &&
    isNullableString(value.git.headRef) &&
    isNullableString(value.git.baseSha) &&
    isNullableString(value.git.headSha) &&
    isNullableString(value.git.mergeBaseSha) &&
    isNullableString(value.git.currentHead) &&
    isNullableString(value.git.currentTree) &&
    isRecord(value.changedPaths) &&
    Array.isArray(value.changedPaths.paths) &&
    value.changedPaths.paths.every((entry) => typeof entry === "string") &&
    isPathStateRecord(value.changedPaths.states) &&
    isRecord(value.plan) &&
    typeof value.plan.summary === "string" &&
    Array.isArray(value.plan.commands) &&
    value.plan.commands.every(isNormalizedCommand) &&
    isReceiptCommand(value.command) &&
    isStringMap(value.env) &&
    isRecord(value.runtime) &&
    typeof value.runtime.platform === "string" &&
    typeof value.runtime.arch === "string" &&
    typeof value.runtime.node === "string" &&
    typeof value.runtime.modules === "string" &&
    typeof value.runtime.v8 === "string" &&
    isNullableString(value.runtime.execPathDigest) &&
    isNullableStringMap(value.invalidationInputs) &&
    (value.expectedWrapperProof === null || isWrapperProof(value.expectedWrapperProof))
  );
}

function isReceiptCommand(value: unknown): value is CheckProofReceipt["requiredInputs"]["command"] {
  return (
    isNormalizedCommand(value) &&
    (value.family === "tsgo" || value.family === "tsgolint" || value.family === "other")
  );
}

function isNormalizedCommand(value: unknown): value is NormalizedCommand {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (typeof value.bin === "string" || value.bin === null) &&
    Array.isArray(value.args) &&
    value.args.every((entry) => typeof entry === "string")
  );
}

function isPathStateRecord(value: unknown): value is Record<string, PathState> {
  return isRecord(value) && Object.values(value).every(isPathState);
}

function isPathState(value: unknown): value is PathState {
  return (
    isRecord(value) &&
    ((value.kind === "missing" && value.digest === null) ||
      ((value.kind === "file" || value.kind === "directory" || value.kind === "other") &&
        typeof value.digest === "string"))
  );
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isNullableStringMap(value: unknown): value is Record<string, string | null> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string" || entry === null)
  );
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
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
  if (receipt.schemaVersion !== 3 || receipt.artifact !== "changed-check evidence receipt") {
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
