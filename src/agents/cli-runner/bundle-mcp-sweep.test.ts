import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundleMcpOwnedMkdtempPrefixName,
  sweepOrphanedBundleMcpTempDirs,
} from "./bundle-mcp-sweep.js";

// Kept in sync with the module-private prefix in bundle-mcp-sweep.ts.
const BUNDLE_MCP_TEMP_PREFIX = "openclaw-cli-mcp-";
const GEMINI_MCP_TEMP_PREFIX = "openclaw-gemini-mcp-";
const GEMINI_MCP_ATTEMPT_TEMP_PREFIX = "openclaw-gemini-mcp-attempt-";
const OLD_MTIME = new Date(Date.now() - 24 * 60 * 60 * 1000);
const BOOT = "a1b2c3d4"; // 8-hex test boot tag
const NS = "4026531836"; // default owner PID-namespace inode tag
const START = "100"; // default owner process start ticks

type Owner = { pid: number; boot?: string; ns?: string; start?: string };

/** Build a temp dir name; owner identity is encoded in the name (or omitted = legacy). */
function dirName(suffix: string, owner?: Owner, prefix = BUNDLE_MCP_TEMP_PREFIX): string {
  if (!owner) {
    return `${prefix}legacy${suffix}`;
  }
  return `${prefix}${owner.pid}-${owner.boot ?? BOOT}-${owner.ns ?? NS}-${owner.start ?? START}-${suffix}`;
}

async function createDir(
  root: string,
  suffix: string,
  options?: { old?: boolean; owner?: Owner; withMcpJson?: boolean; prefix?: string },
) {
  const dir = path.join(root, dirName(suffix, options?.owner, options?.prefix));
  await fs.mkdir(dir, { recursive: true });
  if (options?.withMcpJson !== false) {
    await fs.writeFile(path.join(dir, "mcp.json"), `{"mcpServers":{}}\n`, "utf-8");
  }
  if (options?.old !== false) {
    await fs.utimes(dir, OLD_MTIME, OLD_MTIME);
  }
  return dir;
}

// Owner-aware defaults: on this host the encoded owner is alive with a matching
// start time. Individual tests override isPidAlive/readStartTicks/currentBoot.
function sweep(root: string, over?: Parameters<typeof sweepOrphanedBundleMcpTempDirs>[0]) {
  return sweepOrphanedBundleMcpTempDirs({
    tmpRoot: root,
    currentBoot: BOOT,
    currentNs: NS,
    listCommandLines: () => ["node /usr/bin/unrelated"],
    isPidAlive: () => true,
    readStartTicks: async () => START,
    settleMs: 0,
    ...over,
  });
}

describe("sweepOrphanedBundleMcpTempDirs", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-sweep-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never auto-removes legacy dirs, aged or fresh — an older gateway's queued config must survive a concurrent sweep (rolling-upgrade safe)", async () => {
    const aged = await createDir(root, "aged");
    const fresh = await createDir(root, "fresh", { old: false });
    const result = await sweep(root);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(expect.arrayContaining([aged, fresh]));
    await expect(fs.stat(aged)).resolves.toBeDefined();
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it("keeps dirs referenced by a live CLI child argv (persistent live session, #73244)", async () => {
    const live = await createDir(root, "live");
    const result = await sweep(root, {
      listCommandLines: () => [
        `claude --strict-mcp-config --mcp-config ${path.join(live, "mcp.json")}`,
      ],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([live]);
    await expect(fs.stat(live)).resolves.toBeDefined();
  });

  it("keeps dirs referenced by a concurrent gateway instance's child (owner-dead orphan removed)", async () => {
    const other = await createDir(root, "other-instance");
    const orphan = await createDir(root, "orphan", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      listCommandLines: () => [`claude --mcp-config ${path.join(other, "mcp.json")} --other-flag`],
      isPidAlive: () => false, // the orphan's owning gateway is gone
    });
    expect(result.removed).toEqual([orphan]);
    expect(result.kept).toContain(other);
  });

  it("fails closed when the process scan yields nothing", async () => {
    const orphan = await createDir(root, "orphan");
    const result = await sweep(root, { listCommandLines: () => [] });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([orphan]);
    await expect(fs.stat(orphan)).resolves.toBeDefined();
  });

  it("keeps an aged, unreferenced dir whose owning gateway is still alive (queued run before child spawn)", async () => {
    const queued = await createDir(root, "queued", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: (pid) => pid === 4242,
      readStartTicks: async () => START, // same process — start matches the name
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([queued]);
    await expect(fs.stat(queued)).resolves.toBeDefined();
  });

  it("removes an aged, unreferenced dir whose owning gateway is dead", async () => {
    const orphan = await createDir(root, "dead-owner", { owner: { pid: 4242 } });
    const result = await sweep(root, { isPidAlive: () => false });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("removes an aged, unreferenced dir whose owner boot tag predates a reboot (pid may be reused)", async () => {
    const orphan = await createDir(root, "rebooted", { owner: { pid: 4242, boot: "deadbeef" } });
    const result = await sweep(root, {
      currentBoot: BOOT, // != "deadbeef"
      isPidAlive: () => true, // pid reused after reboot must not protect the dir
      readStartTicks: async () => START,
    });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("removes an aged dir whose pid was reused (alive pid, mismatched start time)", async () => {
    const orphan = await createDir(root, "pid-reuse", { owner: { pid: 4242, start: "100" } });
    const result = await sweep(root, {
      isPidAlive: () => true, // pid 4242 is alive...
      readStartTicks: async () => "999999", // ...but a DIFFERENT process (start mismatch)
    });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("keeps a live-owned dir when start time cannot be verified (off-Linux/hidden, over-protect)", async () => {
    const queued = await createDir(root, "no-start", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: () => true,
      readStartTicks: async () => undefined, // cannot verify → trust the live pid
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([queued]);
  });

  it("keeps a live-owned dir whose creation start was unknown (encoded 0), even when a real start is now readable (fail-closed)", async () => {
    // If creation could not record a start time it encodes "0"; the sweep must
    // NOT compare that against a real start and delete the live owner's config.
    const queued = await createDir(root, "unknown-start", { owner: { pid: 4242, start: "0" } });
    const result = await sweep(root, {
      isPidAlive: () => true,
      readStartTicks: async () => "999999", // a real, DIFFERENT start — must not be read as reuse
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([queued]);
    await expect(fs.stat(queued)).resolves.toBeDefined();
  });

  it("keeps an owner-encoded dir from a DIFFERENT PID namespace even when its pid looks dead (shared /tmp, invisible foreign owner)", async () => {
    // A separate container sharing this /tmp has its own PID namespace. Its
    // gateway pid is not visible here, so process.kill reports it dead — but the
    // config may still be live over there. The namespace mismatch must keep it,
    // so the sweep never deletes a live foreign config. That container's own
    // sweep (where the encoded ns matches) reclaims it once it is truly dead.
    const foreign = await createDir(root, "foreign-ns", { owner: { pid: 4242, ns: "999999" } });
    const result = await sweep(root, { currentNs: NS, isPidAlive: () => false });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([foreign]);
    await expect(fs.stat(foreign)).resolves.toBeDefined();
  });

  it("keeps a dir whose OWNER namespace is unverifiable (nons encoded), even with a dead-looking pid (over-protect)", async () => {
    // Creator could not read its own ns (off-Linux/restricted) -> encoded nons.
    // Same-namespace cannot be proven, so pid liveness is untrusted -> keep.
    const unknownNs = await createDir(root, "owner-nons", { owner: { pid: 4242, ns: "nons" } });
    const result = await sweep(root, { currentNs: NS, isPidAlive: () => false });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([unknownNs]);
    await expect(fs.stat(unknownNs)).resolves.toBeDefined();
  });

  it("keeps a dir when the SWEEPER's own namespace is unreadable (nons), even with a dead-looking pid (fail-closed)", async () => {
    // The sweeping process cannot read /proc/self/ns/pid, so it cannot prove any
    // owner shares its namespace; every owner-encoded dir is kept.
    const dir = await createDir(root, "sweeper-nons", { owner: { pid: 4242 } });
    const result = await sweep(root, { currentNs: "nons", isPidAlive: () => false });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([dir]);
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it("recognizes a name produced by bundleMcpOwnedMkdtempPrefixName as owned by the live gateway", async () => {
    // Producer -> consumer round-trip against real defaults, mirroring the
    // production path: the shared writer joins this name onto the temp root and
    // feeds it to mkdtemp. The running test process is the "owner" and is
    // alive, so its own generated dir is kept.
    const prefixName = await bundleMcpOwnedMkdtempPrefixName();
    expect(prefixName.startsWith(BUNDLE_MCP_TEMP_PREFIX)).toBe(true);
    const dir = await fs.mkdtemp(path.join(root, prefixName));
    await fs.writeFile(path.join(dir, "mcp.json"), `{"mcpServers":{}}\n`, "utf-8");
    await fs.utimes(dir, OLD_MTIME, OLD_MTIME); // aged — owner liveness decides, not age
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([dir]);
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it("resolves the owner identity once and reuses it on later preparations", async () => {
    // Preparation runs on the hot path of every CLI run, so the owner identity
    // must not cost `/proc` I/O each time: pid, boot id, PID namespace and this
    // process's start ticks cannot change while it lives.
    await bundleMcpOwnedMkdtempPrefixName(); // first call warms the cache
    const readFile = vi.spyOn(fs, "readFile");
    const readlink = vi.spyOn(fs, "readlink");
    try {
      const first = await bundleMcpOwnedMkdtempPrefixName();
      const second = await bundleMcpOwnedMkdtempPrefixName();
      expect(first).toBe(second);
      expect(readFile).not.toHaveBeenCalled();
      expect(readlink).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
      readlink.mockRestore();
    }
  });

  it("reclaims a FRESH dead-owner dir regardless of age (owner death, not age, decides)", async () => {
    // A gateway that crashed moments ago leaves fresh debris; the one-shot
    // startup sweep must reclaim it now, not leak it until the next restart.
    const fresh = await createDir(root, "fresh-dead", { old: false, owner: { pid: 4242 } });
    const result = await sweep(root, { isPidAlive: () => false });
    expect(result.removed).toEqual([fresh]);
    await expect(fs.stat(fresh)).rejects.toThrow();
  });

  it("warns with a count when legacy dirs are retained (operator cleanup signal)", async () => {
    await createDir(root, "legacy-a");
    await createDir(root, "legacy-b");
    const warnings: string[] = [];
    const result = await sweep(root, { log: { warn: (msg) => warnings.push(msg) } });
    expect(result.removed).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("retained 2 legacy");
  });

  it("treats an unparseable owner name as legacy (kept, never auto-removed)", async () => {
    // A prefixed dir whose name does not encode a valid owner (e.g. pid 0) is
    // legacy, not owned — like every legacy dir it is never auto-removed.
    const dir = path.join(root, `${BUNDLE_MCP_TEMP_PREFIX}0-${BOOT}-${NS}-${START}-badpid`);
    await fs.mkdir(dir, { recursive: true });
    await fs.utimes(dir, OLD_MTIME, OLD_MTIME);
    const result = await sweep(root);
    expect(result.removed).toEqual([]);
    expect(result.kept).toContain(dir);
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it("keeps a removal candidate whose child spawns between the argv scan and removal", async () => {
    const racing = await createDir(root, "argv-race", { owner: { pid: 4242 } });
    let scan = 0;
    const result = await sweep(root, {
      // First scan: no reference (dead owner → removal candidate). Second scan
      // (immediately before rm): the CLI child has now spawned and references it.
      listCommandLines: () => {
        scan += 1;
        return scan === 1
          ? ["node /usr/bin/unrelated"]
          : [`claude --mcp-config ${path.join(racing, "mcp.json")}`];
      },
      isPidAlive: () => false,
    });
    expect(scan).toBe(2); // re-scan actually happened
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([racing]);
    await expect(fs.stat(racing)).resolves.toBeDefined();
  });

  it("settles after the death verdict, so a child that execs post-verdict is argv-visible by the re-scan", async () => {
    const racing = await createDir(root, "settle-race", { owner: { pid: 4242 } });
    const order: string[] = [];
    let execed = false;
    const result = await sweep(root, {
      settleMs: 5_000,
      // Stands in for the fork→exec transition: the child becomes argv-visible
      // only once the settle has elapsed.
      sleep: async () => {
        order.push("settle");
        execed = true;
      },
      listCommandLines: () => {
        order.push("scan");
        return execed
          ? [`claude --mcp-config ${path.join(racing, "mcp.json")}`]
          : ["node /usr/bin/unrelated"];
      },
      isPidAlive: () => false,
    });
    expect(order).toEqual(["scan", "settle", "scan"]); // settle sits between the two scans
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([racing]);
    await expect(fs.stat(racing)).resolves.toBeDefined();
  });

  it("actually waits on the real timer path (no injected sleep)", async () => {
    const doomed = await createDir(root, "real-settle", { owner: { pid: 4242 } });
    const startedAt = Date.now();
    // No `sleep` override: this exercises the module's own timer.
    const result = await sweep(root, { settleMs: 120, isPidAlive: () => false });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100); // timer really elapsed
    expect(result.removed).toEqual([doomed]); // and the removal still happens after it
  });

  it("cancels the removal when the sidecar aborts during the settle (real AbortController + real timer)", async () => {
    const doomed = await createDir(root, "aborted", { owner: { pid: 4242 } });
    const controller = new AbortController();
    // No `sleep` override: the real timer must be cut short by the real signal.
    setTimeout(() => controller.abort(), 60);
    const startedAt = Date.now();
    const result = await sweep(root, {
      settleMs: 30_000, // would hang the test if the abort were not honoured
      signal: controller.signal,
      isPidAlive: () => false,
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000); // wait was cut short
    expect(result.removed).toEqual([]); // and nothing was deleted after cancellation
    expect(result.kept).toContain(doomed);
    await expect(fs.stat(doomed)).resolves.toBeDefined();
  });

  it("removes nothing when the signal is already aborted before the settle", async () => {
    const doomed = await createDir(root, "pre-aborted", { owner: { pid: 4242 } });
    const sleep = vi.fn(async () => {});
    const result = await sweep(root, {
      settleMs: 5_000,
      signal: AbortSignal.abort(),
      sleep,
      isPidAlive: () => false,
    });
    expect(sleep).not.toHaveBeenCalled(); // no point waiting on an aborted run
    expect(result.removed).toEqual([]);
    expect(result.kept).toContain(doomed);
    await expect(fs.stat(doomed)).resolves.toBeDefined();
  });

  it("does not settle when there is nothing to remove", async () => {
    await createDir(root, "live-owner"); // owner alive → no candidates
    const sleep = vi.fn(async () => {});
    const result = await sweep(root, { settleMs: 5_000, sleep });
    expect(sleep).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
  });

  it("keeps a dir held by an inherited descriptor even when argv never mentions it (pre-exec child)", async () => {
    const preExec = await createDir(root, "held-pre-exec", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: () => false, // owner provably dead
      listCommandLines: () => ["node /usr/bin/unrelated"], // argv is blind, as it is pre-exec
      listHeldDirs: async () => new Set([preExec]), // but the descriptor is durable evidence
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toContain(preExec);
    await expect(fs.stat(preExec)).resolves.toBeDefined();
  });

  it("still removes a dead-owner dir that nobody holds a descriptor into", async () => {
    const doomed = await createDir(root, "unheld", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: () => false,
      listHeldDirs: async () => new Set<string>(), // probe worked; nothing is held
    });
    expect(result.removed).toEqual([doomed]);
  });

  it("falls back to the argv re-scan when the descriptor probe is unavailable (off-Linux)", async () => {
    const doomed = await createDir(root, "no-probe", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: () => false,
      listHeldDirs: async () => undefined, // unknown, e.g. /proc unreadable
    });
    expect(result.removed).toEqual([doomed]); // argv re-scan still governs
  });

  it("removes nothing when the close lands during the phase-two probes (abort after the settle)", async () => {
    const first = await createDir(root, "late-abort-1", { owner: { pid: 4242 } });
    const second = await createDir(root, "late-abort-2", { owner: { pid: 4242 } });
    const controller = new AbortController();
    const result = await sweep(root, {
      isPidAlive: () => false,
      signal: controller.signal,
      listHeldDirs: async () => {
        // The close arrives while the descriptor probe is still in flight —
        // after the settle's own abort check has already passed.
        controller.abort();
        return new Set<string>();
      },
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(expect.arrayContaining([first, second]));
    await expect(fs.stat(first)).resolves.toBeDefined();
    await expect(fs.stat(second)).resolves.toBeDefined();
  });

  it.runIf(process.platform === "linux")(
    "the real descriptor probe sees a holder through a symlinked temp root (canonical identity)",
    async () => {
      // A symlinked TMPDIR makes /proc/<pid>/fd report the RESOLVED target
      // while the sweep's candidates keep the symlink spelling — without
      // canonicalization the probe never matches and a held dir is deleted.
      const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-sweep-realroot-"));
      const linkRoot = `${realRoot}-link`;
      await fs.symlink(realRoot, linkRoot);
      try {
        const heldDir = await createDir(linkRoot, "sym-held", { owner: { pid: 4242 } });
        const handle = await fs.open(path.join(heldDir, "mcp.json"), "r");
        try {
          // No listHeldDirs override: this exercises the module's own /proc scan.
          const result = await sweep(linkRoot, { isPidAlive: () => false });
          expect(result.removed).toEqual([]);
          expect(result.kept).toContain(heldDir);
          await expect(fs.stat(heldDir)).resolves.toBeDefined();
        } finally {
          await handle.close();
        }
        // Control: with the descriptor closed, the same dir through the same
        // symlinked root is reclaimed — the keep above was the fd, not an
        // artifact of the symlink.
        const afterClose = await sweep(linkRoot, { isPidAlive: () => false });
        expect(afterClose.removed).toEqual([heldDir]);
      } finally {
        await fs.rm(linkRoot, { force: true });
        await fs.rm(realRoot, { recursive: true, force: true });
      }
    },
  );

  it("reclaims a dead-owner Gemini settings dir when the descriptor probe proves it unheld", async () => {
    const gemini = await createDir(root, "gem-dead", {
      owner: { pid: 4242 },
      prefix: GEMINI_MCP_TEMP_PREFIX,
    });
    const result = await sweep(root, {
      isPidAlive: () => false,
      listHeldDirs: async () => new Set<string>(),
    });
    expect(result.removed).toEqual([gemini]);
  });

  it("parses the owner of an attempt-prefixed Gemini dir (longest prefix wins, not misread as legacy)", async () => {
    const attempt = await createDir(root, "gem-attempt", {
      owner: { pid: 4242 },
      prefix: GEMINI_MCP_ATTEMPT_TEMP_PREFIX,
    });
    const result = await sweep(root, {
      isPidAlive: () => false,
      listHeldDirs: async () => new Set<string>(),
    });
    // A misparse against the shorter Gemini prefix would classify this dir as
    // legacy and keep it forever.
    expect(result.removed).toEqual([attempt]);
  });

  it("keeps a dead-owner Gemini dir when the descriptor probe is unavailable — env-carried, argv can never clear it", async () => {
    const gemini = await createDir(root, "gem-no-probe", {
      owner: { pid: 4242 },
      prefix: GEMINI_MCP_TEMP_PREFIX,
    });
    const claude = await createDir(root, "cli-no-probe", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: () => false,
      listHeldDirs: async () => undefined, // unknown, e.g. off-Linux
    });
    // The argv re-scan still governs Claude configs (their path travels in
    // argv), but a Gemini settings path travels via env: with the probe gone
    // there is no signal that can prove it unheld, so it is kept.
    expect(result.removed).toEqual([claude]);
    expect(result.kept).toContain(gemini);
    await expect(fs.stat(gemini)).resolves.toBeDefined();
  });

  it("keeps a live-owned Gemini dir and never auto-removes a legacy Gemini dir", async () => {
    const alive = await createDir(root, "gem-alive", {
      owner: { pid: 4242 },
      prefix: GEMINI_MCP_TEMP_PREFIX,
    });
    const legacy = await createDir(root, "gem-legacy", { prefix: GEMINI_MCP_TEMP_PREFIX });
    const warn = vi.fn();
    const result = await sweep(root, {
      isPidAlive: () => true,
      listHeldDirs: async () => new Set<string>(),
      log: { warn },
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(expect.arrayContaining([alive, legacy]));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 legacy"));
  });

  it("recognizes a Gemini name produced by bundleMcpOwnedMkdtempPrefixName as owned by the live gateway", async () => {
    const prefix = await bundleMcpOwnedMkdtempPrefixName(GEMINI_MCP_TEMP_PREFIX);
    expect(prefix.startsWith(GEMINI_MCP_TEMP_PREFIX)).toBe(true);
    const dir = path.join(root, `${prefix}XXXXXX`);
    await fs.mkdir(dir, { recursive: true });
    await fs.utimes(dir, OLD_MTIME, OLD_MTIME);
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
      listHeldDirs: async () => new Set<string>(),
      settleMs: 0,
    });
    // The encoded owner is THIS process (alive), so the aged dir is kept.
    expect(result.removed).toEqual([]);
    expect(result.kept).toContain(dir);
  });

  it("keeps legacy empty dirs (mcp.json already gone) — still never auto-removed", async () => {
    const empty = await createDir(root, "empty", { withMcpJson: false });
    const result = await sweep(root);
    expect(result.removed).toEqual([]);
    expect(result.kept).toContain(empty);
  });

  it("ignores non-matching entries and missing roots", async () => {
    await fs.mkdir(path.join(root, "unrelated-dir"));
    const result = await sweep(root, { listCommandLines: () => ["node"] });
    expect(result.removed).toEqual([]);
    const missing = await sweep(path.join(root, "does-not-exist"), {
      listCommandLines: () => ["node"],
    });
    expect(missing).toEqual({ removed: [], kept: [] });
  });
});
