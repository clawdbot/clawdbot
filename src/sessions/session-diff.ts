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
    const [added, deleted, inlinePath] = token.split("\t");
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
  const newFile = /^\+\+\+ b\/(.+)$/m.exec(chunk);
  if (newFile) {
    return expectDefined(newFile[1], "new file capture group 1");
  }
  // Deleted files have `+++ /dev/null`; key the chunk by the old path.
  const oldFile = /^--- a\/(.+)$/m.exec(chunk);
  if (oldFile) {
    return expectDefined(oldFile[1], "old file capture group 1");
  }
  // Pure renames and binary chunks have neither marker line.
  const renameTo = /^rename to (.+)$/m.exec(chunk);
  if (renameTo) {
    return expectDefined(renameTo[1], "rename to capture group 1");
  }
  const header = /^diff --git a\/.+ b\/(.+)$/m.exec(chunk);
  return header ? expectDefined(header[1], "header capture group 1") : null;
}

/** Splits a multi-file `git diff --patch` into per-file chunks keyed by path. */
export function splitPatchByFile(patch: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!patch.trim()) {
    return byPath;
  }
  const parts = patch.split(/^(?=diff --git )/m);
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

function isBinaryChunk(chunk: string): boolean {
  return /^Binary files .* differ$/m.test(chunk) || chunk.includes("\nGIT binary patch\n");
}

function countPatchAdditions(chunk: string): number {
  let additions = 0;
  let inHunk = false;
  for (const line of chunk.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // Count only hunk-body additions so a `+++foo` content line is not mistaken
    // for the `+++ b/path` header (which always precedes the first hunk).
    if (inHunk && line.startsWith("+")) {
      additions += 1;
    }
  }
  return additions;
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
    // Hardlink/escape guard before git reads the file contents.
    if (!(await isPatchableWorkingTreePath(realRoot, filePath))) {
      files.push({
        path: filePath,
        status: "added",
        additions: 0,
        deletions: 0,
        untracked: true,
        truncated: true,
      });
      continue;
    }
    // Exit code 1 is git's "files differ" for --no-index, not a failure.
    // --no-textconv: checkout-configurable textconv drivers must never run
    // from this read-scoped RPC (same reason as --no-ext-diff).
    const patch = await gitOut(
      root,
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-index",
        "--",
        "/dev/null",
        filePath,
      ],
      [0, 1],
    );
    if (patch === null) {
      files.push({
        path: filePath,
        status: "added",
        additions: 0,
        deletions: 0,
        untracked: true,
        truncated: true,
      });
      continue;
    }
    if (isBinaryChunk(patch)) {
      files.push({
        path: filePath,
        status: "added",
        additions: 0,
        deletions: 0,
        untracked: true,
        binary: true,
      });
      continue;
    }
    const additions = countPatchAdditions(patch);
    files.push({
      path: filePath,
      status: "added",
      additions,
      deletions: 0,
      untracked: true,
      ...takePatch(patch, budget),
    });
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
  // --no-textconv alongside --no-ext-diff: repo config + .gitattributes can
  // define textconv commands, and a read RPC must never execute them.
  const patchText =
    totalChangedLines > MAX_TOTAL_CHANGED_LINES
      ? null
      : await gitOut(root, diffArgs(["--patch", "--no-color", "--no-ext-diff", "--no-textconv"]));
  const chunks = patchText === null ? new Map<string, string>() : splitPatchByFile(patchText);
  const truncated = entries.length > MAX_FILES;
  const files: SessionDiffFile[] = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    const stat = numstat.get(entry.path);
    const chunk = chunks.get(entry.path);
    const binary = stat?.binary === true || (chunk !== undefined && isBinaryChunk(chunk));
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
  const root = (await gitOut(params.cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) {
    return empty("not_git");
  }
  // Canonical root for the hardlink/escape guard: show-toplevel can contain
  // symlinked path segments, and containment is compared against realpaths.
  const realRoot = await fs.realpath(root).catch(() => root);
  const branchOut = (await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  const branch = branchOut && branchOut !== "HEAD" ? branchOut : undefined;
  const head = (await gitOut(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
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
  const root = (await gitOut(params.cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) {
    return undefined;
  }
  const branchOut = (await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  const branch = branchOut && branchOut !== "HEAD" ? branchOut : undefined;
  const hasHead = (await gitOut(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;
  const baseInfo = hasHead
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
  const current = await fingerprintBaselineCandidates({
    candidates: diff.files,
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
