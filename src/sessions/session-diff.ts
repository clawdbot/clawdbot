// Session checkout diff collection and session-start baseline filtering.
import crypto from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../packages/gateway-protocol/src/index.js";
import { gitEnvironment, runGit } from "../agents/worktrees/git.js";
import type { SessionDiffBaseline } from "../config/sessions/types.js";
import { GIT_TIMEOUT_MS } from "../infra/git-exec.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  loadSessionDiffBranchMetadata,
  resolveSessionDiffBase,
  resolveSessionDiffEmptyTree,
} from "./session-diff-revisions.js";

const MAX_FILES = 500;
const MAX_UNTRACKED_FILES = 100;
const MAX_PATCH_BYTES_PER_FILE = 100_000;
const MAX_TOTAL_PATCH_BYTES = 1_500_000;
const MAX_BASELINE_GIT_OUTPUT_BYTES = 512_000;
const MAX_BASELINE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BASELINE_TOTAL_BYTES = 16 * 1024 * 1024;
// Past this the full-patch git call is skipped entirely: runGit buffers stdout
// in memory, so a pathological diff must degrade to stats-only entries.
const MAX_TOTAL_CHANGED_LINES = 100_000;
// Patch consumers require a/b paths. Pin formatting without changing Git's
// content conversions; read-scoped RPCs must not execute diff/textconv drivers.
const PATCH_DIFF_ARGS = [
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

type FileStatus = SessionDiffFile["status"];

type NameStatusEntry = { path: string; oldPath?: string; status: FileStatus };

type NumstatEntry = { additions: number; deletions: number; binary: boolean };

async function gitOut(
  cwd: string,
  args: string[],
  okCodes: readonly number[] = [0],
): Promise<string | null> {
  try {
    // quotePath=false keeps non-ASCII paths raw instead of octal-escaped, so
    // -z output tokens match the byte-for-byte paths git reports elsewhere.
    const result = await runGit(cwd, ["-c", "core.quotePath=false", ...args]);
    return okCodes.includes(result.code ?? -1) ? result.stdout : null;
  } catch {
    return null;
  }
}

async function loadCheckoutRevision(
  cwd: string,
): Promise<{ root: string; head?: string; branch?: string } | undefined> {
  try {
    // Git emits the root before verifying HEAD; exit 1 keeps an unborn checkout's root.
    // Split only the final OID on success so embedded newlines in paths remain intact.
    const result = await runGit(cwd, [
      "rev-parse",
      "--show-toplevel",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
    if (result.termination !== "exit" || (result.code !== 0 && result.code !== 1)) {
      return undefined;
    }
    const lines = result.stdout.replace(/\n$/, "").split("\n");
    const head = result.code === 0 ? lines.pop() : undefined;
    const root = lines.join("\n");
    if (!root) {
      return undefined;
    }
    const branchOut = head
      ? (await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim()
      : undefined;
    return { root, head, branch: branchOut && branchOut !== "HEAD" ? branchOut : undefined };
  } catch {
    return undefined;
  }
}

/** Parses `git diff --name-status -z -M` output; R/C entries consume two paths. */
export function parseNameStatusZ(text: string): NameStatusEntry[] {
  const tokens = text.split("\0");
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (!code) {
      continue;
    }
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      i += 2;
      if (path) {
        entries.push({ path, oldPath, status: letter === "R" ? "renamed" : "added" });
      }
      continue;
    }
    const path = tokens[i + 1];
    i += 1;
    if (!path) {
      continue;
    }
    const status: FileStatus = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    entries.push({ path, status });
  }
  return entries;
}

/** Parses `git diff --numstat -z -M`; rename entries put paths in follow-up tokens. */
export function parseNumstatZ(text: string): Map<string, NumstatEntry> {
  const tokens = text.split("\0");
  const byPath = new Map<string, NumstatEntry>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    const [added, deleted, ...pathParts] = token.split("\t");
    const inlinePath = pathParts.join("\t");
    if (added === undefined || deleted === undefined) {
      continue;
    }
    const binary = added === "-";
    const entry: NumstatEntry = {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    };
    if (inlinePath) {
      byPath.set(inlinePath, entry);
      continue;
    }
    // Rename: `a\tb\t` token, then old and new path tokens; key by new path.
    const path = tokens[i + 2];
    i += 2;
    if (path) {
      byPath.set(path, entry);
    }
  }
  return byPath;
}

function chunkPath(chunk: string): string | null {
  const newFile = /(?:^|\n)\+\+\+ b\/([^\n]+)(?:\n|$)/.exec(chunk);
  if (newFile) {
    return expectDefined(newFile[1], "new file capture group 1");
  }
  // Deleted files have `+++ /dev/null`; key the chunk by the old path.
  const oldFile = /(?:^|\n)--- a\/([^\n]+)(?:\n|$)/.exec(chunk);
  if (oldFile) {
    return expectDefined(oldFile[1], "old file capture group 1");
  }
  // Pure renames and binary chunks have neither marker line.
  const renameTo = /(?:^|\n)rename to ([^\n]+)(?:\n|$)/.exec(chunk);
  if (renameTo) {
    return expectDefined(renameTo[1], "rename to capture group 1");
  }
  const header = /(?:^|\n)diff --git a\/[^\n]+ b\/([^\n]+)(?:\n|$)/.exec(chunk);
  return header ? expectDefined(header[1], "header capture group 1") : null;
}

/** Splits a multi-file `git diff --patch` into per-file chunks keyed by path. */
export function splitPatchByFile(patch: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!patch.trim()) {
    return byPath;
  }
  // Git records end at LF; JavaScript multiline anchors also match content CRs.
  const parts = patch.split(/(?<=\n)(?=diff --git )/);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) {
      continue;
    }
    const path = chunkPath(part);
    if (path) {
      byPath.set(path, part);
    }
  }
  return byPath;
}

function readPatchHeader(chunk: string): { additions?: number; binary: boolean } {
  // A null-to-file addition has one hunk spanning the converted postimage.
  // Stop at the first LF-delimited header so content (including CR) cannot
  // masquerade as binary metadata or a later hunk.
  const header = /(?:^|\n)(@@ [^\n]*|Binary files [^\n]* differ|GIT binary patch)\n/.exec(
    chunk,
  )?.[1];
  const added = /^@@ -0,0 \+1(?:,(\d+))? @@(?: |$)/.exec(header ?? "");
  return {
    ...(added ? { additions: Number(added[1] ?? 1) } : {}),
    binary: header !== undefined && !header.startsWith("@@ "),
  };
}

/**
 * A patch-producing `git diff` reads working-tree file contents, so a
 * checkout-planted hardlink to an out-of-tree secret would otherwise leak
 * through this read-scoped RPC (same threat the fs-safe workspace readers
 * reject). Content is only emitted for a real, single-linked regular file
 * whose realpath stays inside the checkout. Deleted files are exempt: git
 * reads their content from the object DB, never the filesystem.
 */
async function isPatchableWorkingTreePath(realRoot: string, relPath: string): Promise<boolean> {
  const abs = nodePath.resolve(realRoot, relPath);
  try {
    const info = await fs.lstat(abs);
    // Symlinks never leak file contents (git diff shows the link target text,
    // not the pointee), but a hardlink is a second name for another inode.
    if (!info.isFile() || info.nlink !== 1) {
      return false;
    }
    const resolved = await fs.realpath(abs);
    return resolved === realRoot || resolved.startsWith(realRoot + nodePath.sep);
  } catch {
    return false;
  }
}

type PatchBudget = { remaining: number };

function takePatch(
  chunk: string | undefined,
  budget: PatchBudget,
): { patch?: string; truncated?: boolean } {
  if (!chunk) {
    return { truncated: true };
  }
  const bytes = Buffer.byteLength(chunk, "utf8");
  if (bytes > MAX_PATCH_BYTES_PER_FILE || bytes > budget.remaining) {
    return { truncated: true };
  }
  budget.remaining -= bytes;
  return { patch: chunk };
}

async function collectUntrackedFiles(
  root: string,
  realRoot: string,
  budget: PatchBudget,
): Promise<{ files: SessionDiffFile[]; truncated: boolean }> {
  const listing = await gitOut(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = (listing ?? "").split("\0").filter(Boolean);
  const truncated = paths.length > MAX_UNTRACKED_FILES;
  const files: SessionDiffFile[] = [];
  for (const filePath of paths.slice(0, MAX_UNTRACKED_FILES)) {
    const file: SessionDiffFile = {
      path: filePath,
      status: "added",
      additions: 0,
      deletions: 0,
      untracked: true,
    };
    files.push(file);
    // Hardlink/escape guard before git reads the file contents.
    if (!(await isPatchableWorkingTreePath(realRoot, filePath))) {
      file.truncated = true;
      continue;
    }
    const result = await runCommandBuffered(
      [
        "git",
        "-C",
        root,
        "-c",
        "core.quotePath=false",
        "diff",
        ...PATCH_DIFF_ARGS,
        "--no-index",
        "--",
        "/dev/null",
        filePath,
      ],
      {
        timeoutMs: GIT_TIMEOUT_MS,
        env: gitEnvironment(),
        maxOutputBytes: MAX_PATCH_BYTES_PER_FILE,
        // This RPC does not consume Git diagnostics. Verbose converters must
        // not abort otherwise valid diff output by filling an unused stream.
        discardOutput: { stderr: true },
      },
    );
    const patchTruncated =
      result.termination === "output-limit" && result.outputLimitStream === "stdout";
    // --no-index exits 1 for differences, but also for missing input, which
    // has no patch. A complete first hunk retains counts even when its body clips.
    if (
      !patchTruncated &&
      (result.termination !== "exit" || (result.code !== 0 && result.code !== 1))
    ) {
      file.truncated = true;
      continue;
    }
    const patch = result.stdout.toString("utf8");
    if (!patch.startsWith("diff --git ")) {
      file.truncated = true;
      continue;
    }
    const header = readPatchHeader(patch);
    file.additions = header.additions ?? 0;
    if (header.binary) {
      file.binary = true;
      continue;
    }
    Object.assign(file, takePatch(patchTruncated ? undefined : patch, budget));
  }
  return { files, truncated };
}

async function collectTrackedFiles(
  root: string,
  realRoot: string,
  revisions: readonly [base: string] | readonly [base: string, target: string],
  budget: PatchBudget,
): Promise<{ files: SessionDiffFile[]; truncated: boolean }> {
  const diffArgs = (options: string[]) => ["diff", "-M", ...options, ...revisions, "--"];
  const nameStatus = await gitOut(root, diffArgs(["--name-status", "-z"]));
  if (nameStatus === null) {
    return { files: [], truncated: false };
  }
  const entries = parseNameStatusZ(nameStatus);
  if (entries.length === 0) {
    return { files: [], truncated: false };
  }
  const numstatText = (await gitOut(root, diffArgs(["--numstat", "-z"]))) ?? "";
  const numstat = parseNumstatZ(numstatText);
  const totalChangedLines = [...numstat.values()].reduce(
    (sum, entry) => sum + entry.additions + entry.deletions,
    0,
  );
  const patchText =
    totalChangedLines > MAX_TOTAL_CHANGED_LINES
      ? null
      : await gitOut(root, diffArgs(PATCH_DIFF_ARGS));
  const chunks = patchText === null ? new Map<string, string>() : splitPatchByFile(patchText);
  const truncated = entries.length > MAX_FILES;
  const files: SessionDiffFile[] = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    const stat = numstat.get(entry.path);
    const chunk = chunks.get(entry.path);
    const binary = stat?.binary === true || (chunk !== undefined && readPatchHeader(chunk).binary);
    const file: SessionDiffFile = {
      path: entry.path,
      status: entry.status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    };
    if (entry.oldPath) {
      file.oldPath = entry.oldPath;
    }
    if (binary) {
      file.binary = true;
      files.push(file);
      continue;
    }
    // Like the deleted-file exemption, two-revision commit diffs read every
    // path from the object DB. Only working-tree content needs the hardlink guard.
    const safe =
      revisions.length === 2 ||
      entry.status === "deleted" ||
      (await isPatchableWorkingTreePath(realRoot, entry.path));
    if (!safe) {
      file.truncated = true;
      files.push(file);
      continue;
    }
    const taken = takePatch(chunk, budget);
    if (taken.patch !== undefined) {
      file.patch = taken.patch;
    }
    if (taken.truncated) {
      file.truncated = true;
    }
    files.push(file);
  }
  return { files, truncated };
}

type CheckoutDiffParams = { cwd: string; sessionKey: string } & (
  | { scope?: "all" | "uncommitted"; commit?: never }
  | { scope: "commit"; commit: string }
);

export async function loadCheckoutDiff(params: CheckoutDiffParams): Promise<SessionsDiffResult> {
  const empty = (
    unavailableReason?: NonNullable<SessionsDiffResult["unavailableReason"]>,
  ): SessionsDiffResult => ({
    sessionKey: params.sessionKey,
    files: [],
    additions: 0,
    deletions: 0,
    ...(unavailableReason ? { unavailableReason } : {}),
  });
  const checkout = await loadCheckoutRevision(params.cwd);
  if (!checkout) {
    return empty("not_git");
  }
  const { root, head, branch } = checkout;
  // Canonical root for the hardlink/escape guard: show-toplevel can contain
  // symlinked path segments, and containment is compared against realpaths.
  const realRoot = await fs.realpath(root).catch(() => root);
  const branchBase = head
    ? await resolveSessionDiffBase({ branch, gitOut, root })
    : await resolveSessionDiffEmptyTree(root);
  const metadata =
    head && branchBase
      ? await loadSessionDiffBranchMetadata({ base: branchBase.base, gitOut, head, root })
      : {};
  const repositoryFields = {
    sessionKey: params.sessionKey,
    root,
    ...(branch ? { branch } : {}),
    ...(branchBase?.baseRef ? { baseRef: branchBase.baseRef } : {}),
    ...metadata,
  };
  const unknownCommit = (): SessionsDiffResult => ({
    ...repositoryFields,
    files: [],
    additions: 0,
    deletions: 0,
    unavailableReason: "unknown_commit",
  });
  const scope = params.scope ?? "all";
  let revisions: readonly [string] | readonly [string, string] | undefined;
  if (scope === "commit") {
    if (!head || !branchBase || branchBase.base === "HEAD" || branchBase.base === head) {
      return unknownCommit();
    }
    const commit = (
      await gitOut(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${params.commit}^{commit}`,
      ])
    )?.trim();
    if (!commit) {
      return unknownCommit();
    }
    // Commit scope is fenced to the advertised merge-base..HEAD history so an
    // operator.read client cannot read arbitrary commits from the object database.
    const isCommitInHeadHistory =
      (await gitOut(root, ["merge-base", "--is-ancestor", commit, "HEAD"], [0])) !== null;
    const isCommitInBaseHistory =
      (await gitOut(root, ["merge-base", "--is-ancestor", commit, branchBase.base], [0])) !== null;
    if (!isCommitInHeadHistory || isCommitInBaseHistory) {
      return unknownCommit();
    }
    const parent = (await gitOut(root, ["rev-parse", "--verify", "--quiet", `${commit}^`]))?.trim();
    const commitBase = parent ? { base: parent } : await resolveSessionDiffEmptyTree(root);
    revisions = commitBase ? [commitBase.base, commit] : undefined;
  } else if (scope === "uncommitted") {
    revisions = head ? ["HEAD"] : branchBase ? [branchBase.base] : undefined;
  } else {
    revisions = branchBase ? [branchBase.base] : undefined;
  }
  const budget: PatchBudget = { remaining: MAX_TOTAL_PATCH_BYTES };
  const tracked = revisions
    ? await collectTrackedFiles(root, realRoot, revisions, budget)
    : { files: [], truncated: false };
  const untracked =
    scope === "commit"
      ? { files: [], truncated: false }
      : await collectUntrackedFiles(root, realRoot, budget);
  const files = [...tracked.files, ...untracked.files].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const truncated =
    tracked.truncated || untracked.truncated || files.some((file) => file.truncated === true);
  return {
    ...repositoryFields,
    files,
    additions,
    deletions,
    ...(truncated ? { truncated: true } : {}),
  };
}

type BaselineCandidate = Pick<SessionDiffFile, "oldPath" | "path" | "status" | "untracked">;

type BaselineHashBudget = { remaining: number };

function sameMutationFingerprint(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function hashBaselineDescriptor(candidate: BaselineCandidate, content: string): string {
  return crypto
    .createHash("sha256")
    .update(
      [
        candidate.path,
        candidate.oldPath ?? "",
        candidate.status,
        candidate.untracked === true ? "untracked" : "tracked",
        content,
      ].join("\0"),
    )
    .digest("hex");
}

async function fingerprintBaselineCandidate(params: {
  budget: BaselineHashBudget;
  candidate: BaselineCandidate;
  realRoot: string;
  root: string;
}): Promise<string | undefined> {
  const { candidate } = params;
  if (candidate.status === "deleted") {
    return hashBaselineDescriptor(candidate, "deleted");
  }
  const absolutePath = nodePath.resolve(params.root, candidate.path);
  const relativePath = nodePath.relative(params.root, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  const initial = await fs.lstat(absolutePath, { bigint: true }).catch(() => undefined);
  if (!initial) {
    return undefined;
  }
  if (initial.isSymbolicLink()) {
    const target = await fs.readlink(absolutePath).catch(() => undefined);
    return target === undefined
      ? undefined
      : hashBaselineDescriptor(candidate, `symlink:${target}`);
  }
  if (
    !initial.isFile() ||
    initial.nlink !== 1n ||
    initial.size > BigInt(MAX_BASELINE_FILE_BYTES) ||
    initial.size > BigInt(params.budget.remaining)
  ) {
    return undefined;
  }
  const resolved = await fs.realpath(absolutePath).catch(() => undefined);
  if (
    !resolved ||
    (resolved !== params.realRoot && !resolved.startsWith(params.realRoot + nodePath.sep))
  ) {
    return undefined;
  }
  const handle = await fs
    .open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    .catch(() => undefined);
  if (!handle) {
    return undefined;
  }
  params.budget.remaining -= Number(initial.size);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameMutationFingerprint(initial, opened)) {
      return undefined;
    }
    const digest = crypto.createHash("sha256");
    digest.update(
      [
        candidate.path,
        candidate.oldPath ?? "",
        candidate.status,
        candidate.untracked === true ? "untracked" : "tracked",
        opened.mode.toString(),
        opened.size.toString(),
      ].join("\0"),
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(opened.size) - offset),
        offset,
      );
      if (bytesRead === 0) {
        return undefined;
      }
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    return sameMutationFingerprint(opened, final) ? digest.digest("hex") : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function gitOutForBaseline(cwd: string, args: string[]): Promise<string | null> {
  const result = await runCommandBuffered(
    ["git", "-C", cwd, "-c", "core.quotePath=false", ...args],
    {
      timeoutMs: 30_000,
      env: gitEnvironment(),
      maxOutputBytes: {
        stdout: MAX_BASELINE_GIT_OUTPUT_BYTES,
        stderr: 32 * 1024,
      },
    },
  );
  if (result.termination !== "exit" || result.code !== 0) {
    return null;
  }
  return result.stdout.toString("utf8");
}

async function collectBaselineCandidates(params: {
  cwd: string;
}): Promise<{ candidates: BaselineCandidate[]; root: string; truncated: boolean } | undefined> {
  const checkout = await loadCheckoutRevision(params.cwd);
  if (!checkout) {
    return undefined;
  }
  const { root, head, branch } = checkout;
  const baseInfo = head
    ? await resolveSessionDiffBase({ branch, gitOut, root })
    : await resolveSessionDiffEmptyTree(root);
  const trackedText = baseInfo
    ? await gitOutForBaseline(root, ["diff", "-M", baseInfo.base, "--name-status", "-z"])
    : "";
  const untrackedText = await gitOutForBaseline(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (trackedText === null || untrackedText === null) {
    return { root, candidates: [], truncated: true };
  }
  const tracked = parseNameStatusZ(trackedText);
  const untrackedPaths = untrackedText.split("\0").filter(Boolean);
  const candidates = [
    ...tracked.slice(0, MAX_FILES),
    ...untrackedPaths.slice(0, MAX_UNTRACKED_FILES).map((path) => ({
      path,
      status: "added" as const,
      untracked: true,
    })),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    candidates,
    truncated: tracked.length > MAX_FILES || untrackedPaths.length > MAX_UNTRACKED_FILES,
  };
}

async function fingerprintBaselineCandidates(params: {
  candidates: BaselineCandidate[];
  root: string;
}): Promise<{ files: SessionDiffBaseline["files"]; truncated: boolean }> {
  const realRoot = await fs.realpath(params.root).catch(() => params.root);
  const budget: BaselineHashBudget = { remaining: MAX_BASELINE_TOTAL_BYTES };
  const files: SessionDiffBaseline["files"] = [];
  for (const candidate of params.candidates) {
    const fingerprint = await fingerprintBaselineCandidate({
      budget,
      candidate,
      realRoot,
      root: params.root,
    });
    if (fingerprint) {
      files.push({ path: candidate.path, fingerprint });
    }
  }
  return { files, truncated: files.length !== params.candidates.length };
}

export async function captureSessionDiffBaseline(params: {
  cwd: string;
  sessionId: string;
}): Promise<SessionDiffBaseline | undefined> {
  const collected = await collectBaselineCandidates({ cwd: params.cwd });
  if (!collected) {
    return undefined;
  }
  const fingerprinted = await fingerprintBaselineCandidates({
    candidates: collected.candidates,
    root: collected.root,
  });
  return {
    version: 1,
    sessionId: params.sessionId,
    root: collected.root,
    files: fingerprinted.files,
    ...(collected.truncated || fingerprinted.truncated ? { truncated: true } : {}),
  };
}

export async function applySessionDiffBaseline(params: {
  baseline: SessionDiffBaseline | undefined;
  diff: SessionsDiffResult;
  sessionId: string;
}): Promise<SessionsDiffResult> {
  const { baseline, diff } = params;
  if (
    baseline?.version !== 1 ||
    baseline.sessionId !== params.sessionId ||
    !diff.root ||
    baseline.root !== diff.root
  ) {
    return diff;
  }
  const fingerprints = new Map(baseline.files.map((file) => [file.path, file.fingerprint]));
  // New paths cannot match the baseline; hashing them can exhaust the budget
  // before an unchanged pre-session file is compared.
  const current = await fingerprintBaselineCandidates({
    candidates: diff.files.filter((file) => fingerprints.has(file.path)),
    root: diff.root,
  });
  const currentFingerprints = new Map(current.files.map((file) => [file.path, file.fingerprint]));
  const files = diff.files.filter((file) => {
    const baselineFingerprint = fingerprints.get(file.path);
    return !baselineFingerprint || currentFingerprints.get(file.path) !== baselineFingerprint;
  });
  if (files.length === diff.files.length) {
    return diff;
  }
  return {
    ...diff,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
