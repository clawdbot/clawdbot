// Session diff RPC tests run against real throwaway git repos so the parsing
// stays honest about git's -z output and --no-index untracked handling.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import { captureSessionDiffBaseline } from "../../sessions/session-diff.js";
import {
  loadSessionDiff,
  parseNameStatusZ,
  parseNumstatZ,
  sessionsDiffHandlers,
  splitPatchByFile,
} from "./sessions-diff.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntryReadOnly: vi.fn(),
  loadSessionEntry: vi.fn(),
  patchSessionEntryCore: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: hoisted.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: hoisted.loadSessionEntryReadOnly,
  patchSessionEntryCore: hoisted.patchSessionEntryCore,
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

function mockSession(spawnedCwd: string, entry: Record<string, unknown> = {}): void {
  hoisted.loadSessionEntry.mockReturnValue({
    agentId: "main",
    cfg: {},
    entry: { sessionId: "s1", spawnedCwd, ...entry },
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
      agentId: "main",
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

  // Diff and baseline reads run inside the Gateway process against user
  // checkouts, so a checkout-configured core.fsmonitor command (or hook) must
  // never execute — same invariant as the publication git transport.
  it.skipIf(process.platform === "win32")(
    "never executes a checkout-configured core.fsmonitor command",
    async () => {
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\n");
      git(repoRoot, "add", "a.txt");
      git(repoRoot, "commit", "-qm", "init");
      fs.writeFileSync(path.join(repoRoot, "a.txt"), "two\n");
      // Script and sentinel live outside the checkout so they never show up
      // as untracked entries in the diffs under test.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fsmonitor-"));
      try {
        const sentinel = path.join(outside, "sentinel");
        const hook = path.join(outside, "fsmonitor.sh");
        fs.writeFileSync(hook, `#!/bin/sh\n: > "${sentinel}"\nexit 1\n`, { mode: 0o755 });
        git(repoRoot, "config", "core.fsmonitor", hook);
        // Sanity: unpinned git in this checkout does run the command.
        git(repoRoot, "status", "--porcelain");
        expect(fs.existsSync(sentinel)).toBe(true);
        fs.rmSync(sentinel);

        mockSession(repoRoot);
        const diff = await loadSessionDiff({ sessionKey: "agent:main:s1" });
        expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
        const baseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
        expect(baseline?.files.map((file) => file.path)).toEqual(["a.txt"]);
        expect(fs.existsSync(sentinel)).toBe(false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("shows the full diff without mutating a pending baseline claim", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "pending.txt"), "pending first turn\n");
    mockSession(repoRoot, {
      sessionDiffBaselineCapture: {
        version: 1,
        captureId: "pending-capture",
        status: "pending",
      },
    });

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.files.map((file) => file.path)).toEqual(["pending.txt"]);
    expect(hoisted.patchSessionEntryCore).not.toHaveBeenCalled();
  });

  it("uses the persisted fixed-store owner for a bare session checkout", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "owned.txt"), "ops\n");
    const cfg = {
      session: { store: "/tmp/shared.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as const;
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "ops",
      cfg,
      entry: { sessionId: "sess-owned-global" },
      storePath: cfg.session.store,
      canonicalKey: "global",
    });
    hoisted.resolveAgentWorkspaceDir.mockImplementation((_cfg: unknown, agentId: string) =>
      agentId === "ops" ? repoRoot : "/wrong/research",
    );
    const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];

    await sessionsDiffHandlers["sessions.diff"]?.({
      req: { type: "req", id: "sessions.diff", method: "sessions.diff", params: {} },
      params: { sessionKey: "global" },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => calls.push({ ok, payload, error }),
      context: { getRuntimeConfig: () => cfg } as never,
    });

    expect(calls).toEqual([
      expect.objectContaining({
        ok: true,
        payload: expect.objectContaining({ root: repoRoot }),
      }),
    ]);
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith(cfg, "ops");
  });

  it("rejects a foreign agent before loading a bare fixed-store checkout", async () => {
    const cfg = {
      session: { store: "/tmp/shared.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as const;
    const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];

    await sessionsDiffHandlers["sessions.diff"]?.({
      req: { type: "req", id: "sessions.diff", method: "sessions.diff", params: {} },
      params: { sessionKey: "global", agentId: "research" },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => calls.push({ ok, payload, error }),
      context: { getRuntimeConfig: () => cfg } as never,
    });

    expect(calls).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "INVALID_REQUEST",
          message: 'agent "research" does not match session key agent "ops"',
        }),
      }),
    ]);
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
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
    const rootCommit = git(repoRoot, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\nmore\n");
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.baseRef).toBe("HEAD");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.additions).toBe(1);

    const committed = await loadSessionDiff({
      sessionKey: "agent:main:s1",
      scope: "commit",
      commit: rootCommit,
    });
    expect(committed.unavailableReason).toBe("unknown_commit");
    expect(committed.files).toEqual([]);
  });

  it("scopes branch, working-tree, and commit diffs with branch metadata", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "base");
    const mergeBase = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "checkout", "-qb", "sibling");
    fs.writeFileSync(path.join(repoRoot, "sibling.txt"), "sibling commit\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "sibling change");
    const siblingCommit = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "checkout", "-q", "main");
    git(repoRoot, "checkout", "-qb", "feature");

    fs.writeFileSync(path.join(repoRoot, "first.txt"), "first commit\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "first change");
    const firstCommit = git(repoRoot, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoRoot, "second.txt"), "second commit\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "second change");
    const secondCommit = git(repoRoot, "rev-parse", "HEAD").trim();

    fs.appendFileSync(path.join(repoRoot, "second.txt"), "working tree\n");
    fs.writeFileSync(path.join(repoRoot, "loose.txt"), "untracked\n");
    mockSession(repoRoot);

    const all = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(all.files.map((file) => file.path)).toEqual(["first.txt", "loose.txt", "second.txt"]);
    expect(all.aheadCount).toBe(2);
    expect(all.commits).toEqual([
      { sha: git(repoRoot, "rev-parse", "--short", secondCommit).trim(), subject: "second change" },
      { sha: git(repoRoot, "rev-parse", "--short", firstCommit).trim(), subject: "first change" },
    ]);
    expect(all.mergeBase).toEqual({
      sha: git(repoRoot, "rev-parse", "--short", mergeBase).trim(),
      subject: "base",
    });

    const uncommitted = await loadSessionDiff({
      sessionKey: "agent:main:s1",
      scope: "uncommitted",
    });
    expect(uncommitted.files.map((file) => file.path)).toEqual(["loose.txt", "second.txt"]);
    expect(uncommitted.files.find((file) => file.path === "second.txt")?.patch).toContain(
      "+working tree",
    );

    const baseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
    mockSession(repoRoot, { sessionDiffBaseline: baseline });
    const committed = await loadSessionDiff({
      sessionKey: "agent:main:s1",
      scope: "commit",
      commit: firstCommit,
    });
    expect(committed.files.map((file) => file.path)).toEqual(["first.txt"]);
    expect(committed.files[0]?.patch).toContain("+first commit");
    expect(committed.files[0]?.untracked).toBeUndefined();

    for (const commit of [siblingCommit, mergeBase]) {
      const outsideAdvertisedHistory = await loadSessionDiff({
        sessionKey: "agent:main:s1",
        scope: "commit",
        commit,
      });
      expect(outsideAdvertisedHistory.unavailableReason).toBe("unknown_commit");
      expect(outsideAdvertisedHistory.files).toEqual([]);
    }

    const unknown = await loadSessionDiff({
      sessionKey: "agent:main:s1",
      scope: "commit",
      commit: "not-a-commit",
    });
    expect(unknown.unavailableReason).toBe("unknown_commit");
    expect(unknown.files).toEqual([]);
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

  it.skipIf(process.platform === "win32").each(["unborn", "branch", "detached"])(
    "preserves checkout path bytes for %s baseline and diff reads",
    async (revision) => {
      const checkout = path.join(repoRoot, "checkout \n");
      const nested = path.join(checkout, "nested");
      fs.mkdirSync(nested, { recursive: true });
      initRepo(checkout);
      fs.writeFileSync(path.join(checkout, "tracked.txt"), "initial\n");
      git(checkout, "add", "tracked.txt");
      if (revision !== "unborn") {
        git(checkout, "commit", "-qm", "initial");
        if (revision === "detached") {
          git(checkout, "checkout", "--detach", "-q");
        }
      }
      fs.appendFileSync(path.join(checkout, "tracked.txt"), "changed\n");
      fs.writeFileSync(path.join(checkout, "loose.txt"), "new\n");
      mockSession(nested);

      const baseline = await captureSessionDiffBaseline({ cwd: nested, sessionId: "s1" });
      expect(baseline?.root).toBe(checkout);
      expect(baseline?.files.map((file) => file.path)).toEqual(["loose.txt", "tracked.txt"]);
      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });
      expect(result.root).toBe(checkout);
      expect(result.branch).toBe(revision === "branch" ? "main" : undefined);
      expect(result.files.map((file) => file.path)).toEqual(["loose.txt", "tracked.txt"]);

      mockSession(nested, { sessionDiffBaseline: baseline });
      expect((await loadSessionDiff({ sessionKey: "agent:main:s1" })).files).toEqual([]);
      fs.appendFileSync(path.join(checkout, "tracked.txt"), "later edit\n");
      const changed = await loadSessionDiff({ sessionKey: "agent:main:s1" });
      expect(changed.files.map((file) => file.path)).toEqual(["tracked.txt"]);
    },
  );

  it("hides unchanged files captured at session start and resurfaces later edits", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "existing bootstrap\n");
    mockSession(repoRoot);

    const baseline = await captureSessionDiffBaseline({
      cwd: repoRoot,
      sessionId: "s1",
    });
    expect(baseline?.files).toHaveLength(1);

    mockSession(repoRoot, { sessionDiffBaseline: baseline });
    const unchanged = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(unchanged.files).toEqual([]);
    expect(unchanged.additions).toBe(0);

    fs.appendFileSync(path.join(repoRoot, "AGENTS.md"), "added by this session\n");
    const changed = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(changed.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(changed.files[0]?.patch).toContain("+added by this session");
  });

  it("hides unchanged binary files and resurfaces later binary edits", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "icon.bin"), Buffer.from([0, 1, 2, 0, 3]));
    mockSession(repoRoot);

    const baseline = await captureSessionDiffBaseline({
      cwd: repoRoot,
      sessionId: "s1",
    });
    expect(baseline?.files).toHaveLength(1);

    mockSession(repoRoot, { sessionDiffBaseline: baseline });
    const unchanged = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(unchanged.files).toEqual([]);

    fs.writeFileSync(path.join(repoRoot, "icon.bin"), Buffer.from([0, 1, 9, 0, 3]));
    const changed = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(changed.files.map((file) => file.path)).toEqual(["icon.bin"]);
    expect(changed.files[0]?.binary).toBe(true);
  });

  it("keeps pre-session changes hidden when new files exceed the fingerprint budget", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "z-existing.txt"), "preexisting work\n");
    const baseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
    expect(baseline?.files.map((file) => file.path)).toEqual(["z-existing.txt"]);
    const addedPaths = Array.from({ length: 4 }, (_, index) => `a-new-${index}.bin`);
    for (const filePath of addedPaths) {
      fs.writeFileSync(path.join(repoRoot, filePath), Buffer.alloc(4 * 1024 * 1024));
    }
    mockSession(repoRoot, { sessionDiffBaseline: baseline });

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.files.map((file) => file.path)).toEqual(addedPaths);
    expect(result.additions).toBe(0);
  });

  it("skips oversized files instead of materializing them during baseline capture", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "large.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 97));

    const baseline = await captureSessionDiffBaseline({
      cwd: repoRoot,
      sessionId: "s1",
    });

    expect(baseline?.files).toEqual([]);
    expect(baseline?.truncated).toBe(true);
  });

  it("ignores a baseline from an older session generation", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "existing bootstrap\n");
    mockSession(repoRoot);
    const baseline = await captureSessionDiffBaseline({
      cwd: repoRoot,
      sessionId: "old-session",
    });

    mockSession(repoRoot, { sessionDiffBaseline: baseline });
    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
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
    const invalidParams = [
      {},
      { sessionKey: "agent:main:s1", scope: "commit" },
      { sessionKey: "agent:main:s1", scope: "all", commit: "HEAD" },
      { sessionKey: "agent:main:s1", scope: "uncommitted", commit: "HEAD" },
    ];
    for (const params of invalidParams) {
      const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      await sessionsDiffHandlers["sessions.diff"]?.({
        req: { type: "req", id: "sessions.diff", method: "sessions.diff", params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: (ok: boolean, payload?: unknown, error?: unknown) => {
          calls.push({ ok, payload, error });
        },
        context: { getRuntimeConfig: () => ({}) } as never,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(false);
    }
  });
});

describe("ensureSessionDiffBaseline", () => {
  it("does not baseline an existing operator session after upgrade", async () => {
    const entry: SessionEntry = {
      createdVia: "operator",
      sessionId: "existing-session",
      updatedAt: Date.now(),
    };
    hoisted.loadSessionEntryReadOnly.mockReturnValue(entry);

    const result = await ensureSessionDiffBaseline({
      cwd: "/unused",
      entry,
      isNewSession: false,
      sessionKey: "agent:main:existing",
      storePath: "/unused/sessions.json",
    });

    expect(result).toBe(entry);
    expect(hoisted.patchSessionEntryCore).not.toHaveBeenCalled();
  });
});
