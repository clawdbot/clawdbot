import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  createWorkspaceReconcileMetrics,
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  recordRemoteWorkspaceHashMetrics,
  serializeRemoteWorkspaceHashMemo,
  withWorkspaceHashMemo,
} from "./workspace-hash-memo.js";
import { MAX_RECONCILIATION_ENTRIES, type WorkerWorkspaceManifest } from "./workspace-manifest.js";
import { preflightWorkspaceApply, readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function hashMetrics() {
  return {
    contentHashCount: 0,
    contentHashDurationMs: 0,
    memoHitCount: 0,
  };
}

describe("workspace hash memo", () => {
  it("reuses content hashes only within one reconcile stat identity", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-workspace-hash-memo-"));
    const target = path.join(root, "same-size.txt");
    await fs.writeFile(target, "alpha");
    const memo = new Map<string, string>();
    const metrics = hashMetrics();
    let replacedManifestRef = "";
    await withWorkspaceHashMemo(
      memo,
      async () => {
        const first = await readActualWorkspaceManifest({ root, baseCommit: null });
        const unchanged = await withWorkspaceHashMemo(
          memo,
          async () => await readActualWorkspaceManifest({ root, baseCommit: null }),
        );
        expect(unchanged.manifestRef).toBe(first.manifestRef);
        expect(metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 1 });

        await fs.writeFile(target, "bravo");
        await fs.utimes(target, new Date(), new Date(Date.now() + 1_000));
        const changed = await readActualWorkspaceManifest({ root, baseCommit: null });
        expect(changed.manifestRef).not.toBe(first.manifestRef);
        expect(metrics.contentHashCount).toBe(2);

        const replacement = path.join(root, "replacement.txt");
        await fs.writeFile(replacement, "cider");
        await fs.rename(replacement, target);
        const replaced = await readActualWorkspaceManifest({ root, baseCommit: null });
        expect(replaced.manifestRef).not.toBe(changed.manifestRef);
        expect(metrics.contentHashCount).toBe(3);
        replacedManifestRef = replaced.manifestRef;
      },
      metrics,
    );

    const nextReconcileMetrics = hashMetrics();
    const nextReconcile = await withWorkspaceHashMemo(
      new Map(),
      async () => await readActualWorkspaceManifest({ root, baseCommit: null }),
      nextReconcileMetrics,
    );
    expect(nextReconcile.manifestRef).toBe(replacedManifestRef);
    expect(nextReconcileMetrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
  });

  it("reuses local workspace nodes within one preflight but not across fences", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-workspace-preflight-memo-"));
    await fs.writeFile(path.join(root, "parent"), "base");
    const baseContent = Buffer.from("base");
    const currentContent = Buffer.from("worker");
    const base: WorkerWorkspaceManifest = {
      version: 1,
      baseCommit: null,
      entries: [
        {
          path: "parent",
          type: "file",
          mode: 0o644,
          size: baseContent.length,
          sha256: createHash("sha256").update(baseContent).digest("hex"),
        },
      ],
      directories: [],
    };
    const current: WorkerWorkspaceManifest = {
      version: 1,
      baseCommit: null,
      entries: [
        {
          path: "parent/child.txt",
          type: "file",
          mode: 0o644,
          size: currentContent.length,
          sha256: createHash("sha256").update(currentContent).digest("hex"),
        },
        {
          path: "parent/sibling.txt",
          type: "file",
          mode: 0o644,
          size: currentContent.length,
          sha256: createHash("sha256").update(currentContent).digest("hex"),
        },
      ],
      directories: ["parent"],
    };
    const metrics = hashMetrics();
    const open = vi.spyOn(fs, "open");
    const parentPath = path.join(root, "parent");
    const parentSnapshots = () => open.mock.calls.filter(([file]) => file === parentPath).length;

    const first = await withWorkspaceHashMemo(
      new Map(),
      async () => await preflightWorkspaceApply({ root, base, current }),
      metrics,
    );
    expect([...first.applyPaths].toSorted()).toEqual([
      "parent",
      "parent/child.txt",
      "parent/sibling.txt",
    ]);
    expect(metrics.contentHashCount).toBe(1);
    expect(parentSnapshots()).toBe(1);

    await withWorkspaceHashMemo(
      new Map(),
      async () => await preflightWorkspaceApply({ root, base, current }),
      metrics,
    );
    expect(metrics.contentHashCount).toBe(2);
    expect(parentSnapshots()).toBe(2);
  });

  it("aggregates remote metrics and bounds a maximum-entry memo envelope", () => {
    const aggregate = createWorkspaceReconcileMetrics();
    recordRemoteWorkspaceHashMetrics(aggregate, {
      contentHashCount: 7,
      contentHashDurationMs: 11,
      memoHitCount: 13,
      memoTruncatedCount: 17,
      totalDurationMs: 17,
    });
    recordRemoteWorkspaceHashMetrics(aggregate, {
      contentHashCount: 19,
      contentHashDurationMs: 23,
      memoHitCount: 29,
      memoTruncatedCount: 31,
      totalDurationMs: 31,
    });
    expect(aggregate).toMatchObject({
      remoteContentHashCount: 26,
      remoteMemoHitCount: 42,
      remoteMemoTruncatedCount: 48,
      remoteHashDurationMs: 34,
      remoteManifestDurationMs: 48,
    });

    const uint64 = "18446744073709551615";
    const memo = new Map<string, string>();
    for (let index = 0; index < MAX_RECONCILIATION_ENTRIES; index += 1) {
      const inode = String(index).padStart(20, "0");
      memo.set(
        `worker:${uint64}:${inode}:${uint64}:${uint64}:${uint64}`,
        index.toString(16).padStart(64, "0"),
      );
    }
    const serializedMemo = serializeRemoteWorkspaceHashMemo(memo);
    const envelopeBytes = Buffer.byteLength(
      `${JSON.stringify({
        version: 1,
        manifestRef: `sha256:${"f".repeat(64)}`,
        memo: JSON.parse(serializedMemo),
        metrics: {
          contentHashCount: MAX_RECONCILIATION_ENTRIES,
          contentHashDurationMs: Number.MAX_SAFE_INTEGER,
          memoHitCount: MAX_RECONCILIATION_ENTRIES,
          memoTruncatedCount: MAX_RECONCILIATION_ENTRIES,
          totalDurationMs: Number.MAX_SAFE_INTEGER,
        },
      })}\n`,
    );
    expect(envelopeBytes).toBeLessThan(MAX_WORKSPACE_HASH_MEMO_BYTES);
    expect(MAX_WORKSPACE_HASH_MEMO_BYTES - envelopeBytes).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("reuses hashes only for matching stat identities in one remote reconcile", async () => {
    const root = tempDirs.make("openclaw-remote-manifest-memo-");
    const home = path.join(root, "home");
    let workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    workspace = await fs.realpath(workspace);
    const target = path.join(workspace, "same-size.txt");
    await fs.writeFile(target, "alpha");
    const env = { ...process.env, HOME: home };
    type MemoResponse = {
      manifestRef: string;
      memo: [string, string][];
      metrics: { contentHashCount: number; memoHitCount: number };
    };
    const capture = async (memo: [string, string][]): Promise<MemoResponse> => {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, "", "memo-v1"],
        { timeoutMs: 10_000, baseEnv: env, input: JSON.stringify(memo) },
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      return JSON.parse(result.stdout) as MemoResponse;
    };

    const first = await capture([]);
    expect(first.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
    const unchanged = await capture(first.memo);
    expect(unchanged.manifestRef).toBe(first.manifestRef);
    expect(unchanged.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });

    await fs.writeFile(target, "bravo");
    await fs.utimes(target, new Date(), new Date(Date.now() + 1_000));
    const changed = await capture(unchanged.memo);
    expect(changed.manifestRef).not.toBe(first.manifestRef);
    expect(changed.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });

    const replacement = path.join(workspace, "replacement.txt");
    await fs.writeFile(replacement, "cider");
    await fs.rename(replacement, target);
    const replaced = await capture(changed.memo);
    expect(replaced.manifestRef).not.toBe(changed.manifestRef);
    expect(replaced.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });

    const nextReconcile = await capture([]);
    expect(nextReconcile.manifestRef).toBe(replaced.manifestRef);
    expect(nextReconcile.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
  });

  it("bounds the remote memo to the largest files and reports truncation", async () => {
    const root = tempDirs.make("openclaw-remote-manifest-memo-cap-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    await Promise.all([
      fs.writeFile(path.join(workspace, "small.txt"), "1"),
      fs.writeFile(path.join(workspace, "medium.txt"), "22"),
      fs.writeFile(path.join(workspace, "large.txt"), "333"),
    ]);
    const limitDeclaration = `const MAX_RECONCILIATION_ENTRIES = ${MAX_RECONCILIATION_ENTRIES};`;
    const limitedScript = REMOTE_WORKSPACE_MANIFEST_JS.replace(
      limitDeclaration,
      "const MAX_RECONCILIATION_ENTRIES = 2;",
    );
    expect(limitedScript).not.toBe(REMOTE_WORKSPACE_MANIFEST_JS);
    const env = { ...process.env, HOME: home };
    type MemoResponse = {
      manifestRef: string;
      memo: [string, string][];
      metrics: { contentHashCount: number; memoHitCount: number; memoTruncatedCount: number };
    };
    const capture = async (memo: [string, string][]): Promise<MemoResponse> => {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", limitedScript, workspace, "", "memo-v1"],
        { timeoutMs: 10_000, baseEnv: env, input: JSON.stringify(memo) },
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      return JSON.parse(result.stdout) as MemoResponse;
    };

    const first = await capture([]);
    expect(first.memo).toHaveLength(2);
    expect(
      first.memo
        .map(([identity]) => Number(identity.split(":")[3]))
        .toSorted((left, right) => left - right),
    ).toEqual([2, 3]);
    expect(first.metrics).toMatchObject({
      contentHashCount: 3,
      memoHitCount: 0,
      memoTruncatedCount: 1,
    });

    const unchanged = await capture(first.memo);
    expect(unchanged.manifestRef).toBe(first.manifestRef);
    expect(unchanged.memo).toEqual(first.memo);
    expect(unchanged.metrics).toMatchObject({
      contentHashCount: 1,
      memoHitCount: 2,
      memoTruncatedCount: 1,
    });
  });
});
