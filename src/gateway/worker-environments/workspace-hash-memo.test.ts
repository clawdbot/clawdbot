import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureManifest } from "../../node-host/node-worker-workspace-commands.js";
import * as processExec from "../../process/exec.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  createWorkspaceReconcileMetrics,
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  parseRemoteWorkspaceManifestEnvelope,
  pruneWorkspaceHashMemo,
  recordRemoteWorkspaceHashMetrics,
  serializeRemoteWorkspaceHashMemo,
  serializeRemoteWorkspaceManifestEnvelope,
  withWorkspaceHashMemo,
  withWorkerWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "./workspace-hash-memo.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import { preflightWorkspaceApply, readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { captureRemoteWorkspaceManifest } from "./workspace-sync-helpers.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function manifestChildEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C.UTF-8",
    ...(process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home, TEMP: home, TMP: home }
      : {}),
  };
}

function hashMetrics() {
  return {
    contentHashCount: 0,
    contentHashDurationMs: 0,
    memoHitCount: 0,
  };
}

describe("workspace hash memo", () => {
  it("retains a full inventory memo above the reconciliation count when its bytes fit", () => {
    const memo: WorkspaceHashMemo = new Map(
      Array.from({ length: 36_000 }, (_, index) => [
        `worker:1:${index}:1:2:3`,
        index.toString(16).padStart(64, "0"),
      ]),
    );
    const encoded = serializeRemoteWorkspaceHashMemo(memo);
    expect(Buffer.byteLength(encoded)).toBeLessThan(MAX_WORKSPACE_HASH_MEMO_BYTES);
    expect(JSON.parse(encoded)).toHaveLength(memo.size);
  });

  it("retains the largest hashes in an actual envelope within the complete transport byte cap", async () => {
    const root = tempDirs.make("workspace-memo-envelope-");
    const memo: WorkspaceHashMemo = new Map(
      Array.from({ length: 70_000 }, (_, index) => [
        `worker:18446744073709551615:${18446744073709551615n - BigInt(index)}:${index + 1}:1700000000000000000:1700000000000000000`,
        index.toString(16).padStart(64, "0"),
      ]),
    );
    const manifestRef = `sha256:${"a".repeat(64)}`;
    const metrics = { ...hashMetrics(), memoTruncatedCount: 0, totalDurationMs: 123.456 };
    const raw = serializeRemoteWorkspaceManifestEnvelope(manifestRef, memo, metrics);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_WORKSPACE_HASH_MEMO_BYTES);
    const envelope = parseRemoteWorkspaceManifestEnvelope(raw);
    expect(envelope.memo.length).toBeGreaterThan(25_000);
    expect(envelope.memo.length).toBeLessThan(memo.size);
    expect(envelope.metrics.memoTruncatedCount).toBe(memo.size - envelope.memo.length);
    expect(envelope.memo.map(([identity]) => Number(identity.split(":")[3]))).not.toContain(1);
    expect(envelope.memo.map(([identity]) => Number(identity.split(":")[3]))).toContain(70_000);
    expect(
      serializeRemoteWorkspaceManifestEnvelope(
        manifestRef,
        new Map([...memo].toReversed()),
        metrics,
      ),
    ).toBe(raw);
    const retained = new Set(envelope.memo.map(([identity]) => identity));
    const omitted = [...memo].find(([identity]) => !retained.has(identity))!;
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ...envelope,
          memo: [...envelope.memo, omitted],
          metrics: {
            ...envelope.metrics,
            memoTruncatedCount: envelope.metrics.memoTruncatedCount - 1,
          },
        }) + "\n",
      ),
    ).toBeGreaterThan(MAX_WORKSPACE_HASH_MEMO_BYTES);

    // Exercise the byte-limited child-process path without providers or inherited credentials.
    const echo = async (body: string, maxOutputBytes: number) =>
      await runCommandWithTimeout([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], {
        baseEnv: manifestChildEnv(root),
        input: body,
        timeoutMs: 10_000,
        maxOutputBytes,
      });
    const received: WorkspaceHashMemo = new Map();
    await expect(
      captureRemoteWorkspaceManifest({
        runWorkspaceCommand: () => echo(raw, MAX_WORKSPACE_HASH_MEMO_BYTES),
        remoteWorkspaceDir: root,
        baseCommit: null,
        priorManifestDigests: [],
        hashMemo: received,
        metrics: createWorkspaceReconcileMetrics(),
      }),
    ).resolves.toBe(manifestRef);
    expect(received.size).toBe(envelope.memo.length);

    const run = runCommandWithTimeout;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(
      async (_argv, options) =>
        await run([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], {
          ...(typeof options === "number" ? { timeoutMs: options } : options),
          input: raw,
          baseEnv: manifestChildEnv(root),
        }),
    );
    const nodeMemo: WorkspaceHashMemo = new Map();
    await expect(
      captureManifest({
        workspaceDir: root,
        manifestHome: root,
        baseCommit: null,
        referenceManifestRef: manifestRef,
        hashMemo: nodeMemo,
      }),
    ).resolves.toMatchObject({ manifestRef });
    expect(nodeMemo.size).toBe(envelope.memo.length);
    expect(() =>
      parseRemoteWorkspaceManifestEnvelope(
        raw + " ".repeat(MAX_WORKSPACE_HASH_MEMO_BYTES - Buffer.byteLength(raw) + 1),
      ),
    ).toThrow("byte limit");
  });

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

  it("aggregates remote capture metrics", () => {
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
  });

  it("reuses hashes only for matching stat identities in one remote reconcile", async () => {
    const root = tempDirs.make("openclaw-remote-manifest-memo-");
    const home = path.join(root, "home");
    let workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    workspace = await fs.realpath(workspace);
    const target = path.join(workspace, "same-size.txt");
    await fs.writeFile(target, "alpha");
    const env = manifestChildEnv(home);
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
    const largeInput = await capture([
      ...Array.from({ length: 36_000 }, (_, index): [string, string] => [
        `worker:0:${index}:1:0:0`,
        "a".repeat(64),
      ]),
      ...first.memo,
    ]);
    expect(largeInput.manifestRef).toBe(first.manifestRef);
    expect(largeInput.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
    const nodeMemo: WorkspaceHashMemo = new Map();
    await withWorkerWorkspaceHashMemo(nodeMemo, () =>
      readActualWorkspaceManifest({ root: workspace, baseCommit: null }),
    );
    const nodeValidated = await capture([...nodeMemo]);
    expect(nodeValidated.manifestRef).toBe(first.manifestRef);
    expect(nodeValidated.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
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

    await fs.chmod(target, 0o755);
    const executable = await capture(replaced.memo);
    if (process.platform !== "win32") {
      expect(executable.manifestRef).not.toBe(replaced.manifestRef);
    }
    await fs.unlink(target);
    await fs.symlink("other.txt", target);
    const symlink = await capture(executable.memo);
    expect(symlink.manifestRef).not.toBe(executable.manifestRef);
    expect(symlink.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 0 });
  });
});

describe("placement hash memo pruning", () => {
  it("keeps a memo under the byte cap and clears one that exceeds it", () => {
    const retained: WorkspaceHashMemo = new Map([
      ["worker:1:2:3:4:5", "a".repeat(64)],
      ["gateway:1:2:3:4:5", "b".repeat(64)],
    ]);
    pruneWorkspaceHashMemo(retained);
    expect(retained.size).toBe(2);

    const digest = "c".repeat(64);
    const oversized: WorkspaceHashMemo = new Map();
    let bytes = 0;
    for (let index = 0; bytes <= MAX_WORKSPACE_HASH_MEMO_BYTES; index += 1) {
      const identity = `gateway:${index}:0:0:0:0`;
      oversized.set(identity, digest);
      bytes += identity.length + digest.length;
    }
    pruneWorkspaceHashMemo(oversized);
    expect(oversized.size).toBe(0);
  });
});
