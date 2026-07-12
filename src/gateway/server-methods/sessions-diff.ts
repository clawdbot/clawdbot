// Session checkout diff for operator clients: branch + working-tree changes
// against the checkout's default-branch merge base, structured per file so the
// Control UI diff panel can render without shelling out client-side.
import fs from "node:fs/promises";
import nodePath from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  validateSessionsDiffParams,
  type SessionDiffFile,
  type SessionsDiffParams,
  type SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { runGit } from "../../agents/worktrees/git.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_FILES = 500;
const MAX_UNTRACKED_FILES = 100;
const MAX_PATCH_BYTES_PER_FILE = 100_000;
const MAX_TOTAL_PATCH_BYTES = 1_500_000;
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

/**
 * Picks the ref the session diff is computed against: merge-base with the
 * remote default branch when on a feature branch, otherwise HEAD so sessions
 * on the default branch still surface uncommitted work.
 */
async function resolveDiffBase(
  root: string,
  branch: string | undefined,
): Promise<{ base: string; baseRef: string }> {
  const defaultRef = await gitOut(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const remoteDefault = defaultRef?.trim() || null;
  const defaultShort = remoteDefault?.replace(/^origin\//, "");
  if (remoteDefault && defaultShort && branch && branch !== defaultShort) {
    const mergeBase = await gitOut(root, ["merge-base", remoteDefault, "HEAD"]);
    if (mergeBase?.trim()) {
      return { base: mergeBase.trim(), baseRef: defaultShort };
    }
  }
  // No usable remote default: try a local main/master so plain clones still
  // get a branch-relative diff instead of only uncommitted changes.
  if (branch && branch !== "main" && branch !== "master") {
    for (const candidate of ["main", "master"]) {
      const verified = await gitOut(root, ["rev-parse", "--verify", "--quiet", candidate]);
      if (verified?.trim()) {
        const mergeBase = await gitOut(root, ["merge-base", candidate, "HEAD"]);
        if (mergeBase?.trim()) {
          return { base: mergeBase.trim(), baseRef: candidate };
        }
      }
    }
  }
  return { base: "HEAD", baseRef: "HEAD" };
}

/**
 * Diff base for a repo before its first commit: the empty-tree object id, so
 * `git diff <empty>` reports staged/index files as additions. `hash-object`
 * derives the id for the repo's object format (SHA-1 vs SHA-256) and does not
 * write to the object DB. baseRef stays undefined — there is no named base.
 */
async function resolveUnbornDiffBase(
  root: string,
): Promise<{ base: string; baseRef?: string } | null> {
  try {
    const result = await runGit(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
    const emptyTree = result.code === 0 ? result.stdout.trim() : "";
    return emptyTree ? { base: emptyTree } : null;
  } catch {
    return null;
  }
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
  base: string,
  budget: PatchBudget,
): Promise<{ files: SessionDiffFile[]; truncated: boolean }> {
  const diffArgs = ["diff", "-M", base];
  const nameStatus = await gitOut(root, [...diffArgs, "--name-status", "-z"]);
  if (nameStatus === null) {
    return { files: [], truncated: false };
  }
  const entries = parseNameStatusZ(nameStatus);
  if (entries.length === 0) {
    return { files: [], truncated: false };
  }
  const numstatText = (await gitOut(root, [...diffArgs, "--numstat", "-z"])) ?? "";
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
      : await gitOut(root, [
          ...diffArgs,
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
        ]);
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
    // Deleted files diff against the object DB (no filesystem read); every
    // other status reads the working-tree file, so hardlink-guard it before
    // returning content the bulk diff already buffered server-side.
    const safe =
      entry.status === "deleted" || (await isPatchableWorkingTreePath(realRoot, entry.path));
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

export async function loadSessionDiff(params: SessionsDiffParams): Promise<SessionsDiffResult> {
  const empty = (
    unavailableReason?: NonNullable<SessionsDiffResult["unavailableReason"]>,
  ): SessionsDiffResult => ({
    sessionKey: params.sessionKey,
    files: [],
    additions: 0,
    deletions: 0,
    ...(unavailableReason ? { unavailableReason } : {}),
  });
  const { cfg, entry, storePath, canonicalKey } = loadSessionEntry(params.sessionKey, {
    agentId: params.agentId,
  });
  // Same session scoping as sessions.files.*: an unknown session must not fall
  // back to some agent workspace and surface another checkout's diff.
  if (!entry?.sessionId || !storePath) {
    return empty("unknown_session");
  }
  const agentId = normalizeAgentId(
    parseAgentSessionKey(canonicalKey)?.agentId ??
      params.agentId ??
      parseAgentSessionKey(params.sessionKey)?.agentId ??
      resolveDefaultAgentId(cfg),
  );
  // spawnedCwd first, matching controlUi.sessionPullRequests: the diff must
  // describe the same checkout whose branch the PR chips report.
  const cwd =
    normalizeOptionalString(entry.spawnedCwd) ??
    normalizeOptionalString(entry.spawnedWorkspaceDir) ??
    normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId));
  if (!cwd) {
    return empty("unknown_session");
  }
  const root = (await gitOut(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) {
    return empty("not_git");
  }
  // Canonical root for the hardlink/escape guard: show-toplevel can contain
  // symlinked path segments, and containment is compared against realpaths.
  const realRoot = await fs.realpath(root).catch(() => root);
  const branchOut = (await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  const branch = branchOut && branchOut !== "HEAD" ? branchOut : undefined;
  const budget: PatchBudget = { remaining: MAX_TOTAL_PATCH_BYTES };
  // Repos before their first commit have no HEAD, so diff the index/worktree
  // against the empty tree to surface staged files (the untracked scan below
  // only covers files git does not track yet). hash-object derives the empty
  // tree id for the repo's object format without writing to the object DB.
  const hasHead = (await gitOut(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;
  const baseInfo = hasHead
    ? await resolveDiffBase(root, branch)
    : await resolveUnbornDiffBase(root);
  const tracked = baseInfo
    ? await collectTrackedFiles(root, realRoot, baseInfo.base, budget)
    : { files: [], truncated: false };
  const untracked = await collectUntrackedFiles(root, realRoot, budget);
  const files = [...tracked.files, ...untracked.files].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const truncated =
    tracked.truncated || untracked.truncated || files.some((file) => file.truncated === true);
  return {
    sessionKey: params.sessionKey,
    root,
    ...(branch ? { branch } : {}),
    ...(baseInfo?.baseRef ? { baseRef: baseInfo.baseRef } : {}),
    files,
    additions,
    deletions,
    ...(truncated ? { truncated: true } : {}),
  };
}

export const sessionsDiffHandlers: GatewayRequestHandlers = {
  "sessions.diff": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsDiffParams, "sessions.diff", respond)) {
      return;
    }
    respond(true, await loadSessionDiff(params));
  },
};
