// Session diff RPC tests run against real throwaway git repos so the parsing
// stays honest about git's -z output and --no-index untracked handling.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionDiff,
  parseNameStatusZ,
  parseNumstatZ,
  sessionsDiffHandlers,
  splitPatchByFile,
} from "./sessions-diff.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: hoisted.loadSessionEntry,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@openclaw.test");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
}

function mockSession(spawnedCwd: string): void {
  hoisted.loadSessionEntry.mockReturnValue({
    cfg: {},
    entry: { sessionId: "s1", spawnedCwd },
    storePath: "/tmp/sessions.json",
    canonicalKey: "agent:main:s1",
  });
}

describe("sessions.diff parsers", () => {
  it("parses name-status -z including renames", () => {
    const entries = parseNameStatusZ("M\0a.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0");
    expect(entries).toEqual([
      { path: "a.txt", status: "modified" },
      { path: "new.txt", oldPath: "old.txt", status: "renamed" },
      { path: "gone.txt", status: "deleted" },
    ]);
  });

  it("parses numstat -z including rename and binary entries", () => {
    // NUL separators written as \u0000: a bare \0 before a digit would
    // parse as an octal escape.
    const byPath = parseNumstatZ(
      "2\t1\ta.txt\u0000-\t-\tblob.bin\u00000\t0\t\u0000old.txt\u0000new.txt\u0000",
    );
    expect(byPath.get("a.txt")).toEqual({ additions: 2, deletions: 1, binary: false });
    expect(byPath.get("blob.bin")).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(byPath.get("new.txt")).toEqual({ additions: 0, deletions: 0, binary: false });
  });

  it("splits multi-file patches and keys deleted files by old path", () => {
    const patch = [
      "diff --git a/kept.txt b/kept.txt",
      "index 000..111 100644",
      "--- a/kept.txt",
      "+++ b/kept.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    const chunks = splitPatchByFile(patch);
    expect([...chunks.keys()]).toEqual(["kept.txt", "gone.txt"]);
    expect(chunks.get("kept.txt")).toContain("+new");
  });
});

describe("loadSessionDiff", () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-diff-")));
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(repoRoot);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("reports unknown sessions without touching a workspace", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: undefined,
      storePath: undefined,
      canonicalKey: "agent:main:missing",
    });
    const result = await loadSessionDiff({ sessionKey: "agent:main:missing" });
    expect(result.unavailableReason).toBe("unknown_session");
    expect(result.files).toEqual([]);
  });

  it("reports non-git checkouts", async () => {
    mockSession(repoRoot);
    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(result.unavailableReason).toBe("not_git");
  });

  it("diffs a feature branch against the local default branch", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(repoRoot, "old.txt"), "keep\n");
    fs.writeFileSync(path.join(repoRoot, "gone.txt"), "bye\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    git(repoRoot, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\nTWO\nthree\nfour\n");
    git(repoRoot, "mv", "old.txt", "renamed.txt");
    git(repoRoot, "rm", "-q", "gone.txt");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "change");
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "hello\nworld\n");
    fs.writeFileSync(path.join(repoRoot, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.unavailableReason).toBeUndefined();
    expect(result.root).toBe(repoRoot);
    expect(result.branch).toBe("feature");
    expect(result.baseRef).toBe("main");
    expect(result.files.map((file) => file.path)).toEqual([
      "a.txt",
      "blob.bin",
      "gone.txt",
      "renamed.txt",
      "untracked.txt",
    ]);

    const modified = result.files.find((file) => file.path === "a.txt");
    expect(modified?.status).toBe("modified");
    expect(modified?.additions).toBe(2);
    expect(modified?.deletions).toBe(1);
    expect(modified?.patch).toContain("+TWO");

    const renamed = result.files.find((file) => file.path === "renamed.txt");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("old.txt");

    const deleted = result.files.find((file) => file.path === "gone.txt");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.patch).toContain("-bye");

    const untracked = result.files.find((file) => file.path === "untracked.txt");
    expect(untracked?.status).toBe("added");
    expect(untracked?.untracked).toBe(true);
    expect(untracked?.additions).toBe(2);
    expect(untracked?.patch).toContain("+hello");

    const binary = result.files.find((file) => file.path === "blob.bin");
    expect(binary?.binary).toBe(true);
    expect(binary?.patch).toBeUndefined();

    expect(result.additions).toBe(4);
    expect(result.deletions).toBe(2);
  });

  it("diffs uncommitted work on the default branch against HEAD", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\nmore\n");
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.baseRef).toBe("HEAD");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.additions).toBe(1);
  });

  it("never executes configured textconv drivers from the read RPC", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, ".gitattributes"), "*.txt diff=evil\n");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    const marker = path.join(repoRoot, "pwned");
    git(repoRoot, "config", "diff.evil.textconv", `touch ${marker}; cat`);
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "new\n");
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(fs.existsSync(marker)).toBe(false);
    const tracked = result.files.find((file) => file.path === "a.txt");
    expect(tracked?.patch).toContain("+two");
  });

  it("withholds patch content for hardlinked files pointing outside the checkout", async () => {
    const secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-")));
    const secretFile = path.join(secretDir, "secret.txt");
    fs.writeFileSync(secretFile, "TOP SECRET VALUE\n");
    try {
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "seed.txt"), "seed\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "init");
      // Untracked hardlink to an out-of-tree secret: same inode, in-tree name.
      fs.linkSync(secretFile, path.join(repoRoot, "leak.txt"));
      // Tracked file replaced by a hardlink to the same secret after commit.
      fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "original\n");
      git(repoRoot, "add", "tracked.txt");
      git(repoRoot, "commit", "-qm", "add tracked");
      fs.rmSync(path.join(repoRoot, "tracked.txt"));
      fs.linkSync(secretFile, path.join(repoRoot, "tracked.txt"));
      mockSession(repoRoot);

      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

      expect(JSON.stringify(result)).not.toContain("TOP SECRET VALUE");
      for (const name of ["leak.txt", "tracked.txt"]) {
        const file = result.files.find((entry) => entry.path === name);
        expect(file?.patch).toBeUndefined();
        expect(file?.truncated).toBe(true);
      }
    } finally {
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it("reports staged files in a repo before its first commit", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "staged.txt"), "line one\nline two\n");
    git(repoRoot, "add", "staged.txt");
    fs.writeFileSync(path.join(repoRoot, "loose.txt"), "loose\n");
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.unavailableReason).toBeUndefined();
    const staged = result.files.find((file) => file.path === "staged.txt");
    expect(staged?.status).toBe("added");
    expect(staged?.additions).toBe(2);
    expect(staged?.patch).toContain("+line one");
    // The untracked scan still covers files git does not track yet.
    expect(result.files.find((file) => file.path === "loose.txt")?.untracked).toBe(true);
  });

  it("counts untracked additions whose content begins with plus signs", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    // Content lines rendered as `+++more`/`++i` must not be read as the header.
    fs.writeFileSync(path.join(repoRoot, "diffish.txt"), "++i\n+++more\nplain\n");
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    const file = result.files.find((entry) => entry.path === "diffish.txt");
    expect(file?.additions).toBe(3);
  });

  it("rejects invalid params through the handler", async () => {
    const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
    await sessionsDiffHandlers["sessions.diff"]?.({
      req: { type: "req", id: "sessions.diff", method: "sessions.diff", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        calls.push({ ok, payload, error });
      },
      context: { getRuntimeConfig: () => ({}) } as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ok).toBe(false);
  });
});
