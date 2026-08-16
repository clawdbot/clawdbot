import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function temporaryDirectory(name: string): Promise<string> {
  return tempDirs.make(`openclaw-${name}-`);
}

function encodeManifest(manifest: WorkerWorkspaceManifest) {
  const raw = serializeWorkerWorkspaceManifest(manifest);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

async function stageHistoricalV1Result(params: {
  root: string;
  resultRoot: string;
  ref: string;
  base: ReturnType<typeof encodeManifest>;
  current: ReturnType<typeof encodeManifest>;
  manifest: WorkerWorkspaceManifest;
}): Promise<void> {
  const blobs = await Promise.all(
    params.manifest.entries.map(async (entry, index) => ({
      entry,
      mark: index + 1,
      content: await fs.readFile(path.join(params.resultRoot, entry.path)),
    })),
  );
  const base = Buffer.from(params.base.raw);
  const current = Buffer.from(params.current.raw);
  const message = Buffer.concat([
    Buffer.from(
      `OpenClaw worker workspace result\nversion 1\nbase-ref ${params.base.ref}\ncurrent-ref ${params.current.ref}\nbase-bytes ${base.byteLength}\ncurrent-bytes ${current.byteLength}\n\n`,
    ),
    base,
    current,
  ]);
  const chunks: Uint8Array[] = blobs.flatMap((blob) => [
    Buffer.from(`blob\nmark :${blob.mark}\ndata ${blob.content.byteLength}\n`),
    blob.content,
    Buffer.from("\n"),
  ]);
  chunks.push(
    Buffer.from(
      `commit ${params.ref}\nauthor OpenClaw <openclaw@localhost> 0 +0000\ncommitter OpenClaw <openclaw@localhost> 0 +0000\ndata ${message.byteLength}\n`,
    ),
    message,
    Buffer.from("\ndeleteall\n"),
    ...blobs.map((blob) => Buffer.from(`M 100644 :${blob.mark} ${blob.entry.path}\n`)),
    Buffer.from("done\n"),
  );
  const result = await runCommandWithTimeout(["git", "-C", params.root, "fast-import", "--quiet"], {
    timeoutMs: 10_000,
    input: Buffer.concat(chunks),
  });
  expect(result.code, result.stderr).toBe(0);
}

it("recovers the shipped v1 full tree while applying only changed entries", async () => {
  const local = await temporaryDirectory("workspace-staged-v1-local");
  const complete = await temporaryDirectory("workspace-staged-v1-complete");
  const baseContents = { "changed.txt": "base\n", "keep.txt": "keep\n" };
  const currentContents = { ...baseContents, "changed.txt": "worker\n" };
  for (const [name, contents] of Object.entries(baseContents)) {
    await fs.writeFile(path.join(local, name), contents);
  }
  for (const [name, contents] of Object.entries(currentContents)) {
    await fs.writeFile(path.join(complete, name), contents);
  }
  const manifest = (contents: Record<string, string>): WorkerWorkspaceManifest => ({
    version: 1,
    baseCommit: null,
    entries: Object.entries(contents).map(([entryPath, content]) => ({
      path: entryPath,
      type: "file",
      mode: 0o644,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  });
  const base = encodeManifest(manifest(baseContents));
  const currentManifest = manifest(currentContents);
  const current = encodeManifest(currentManifest);
  const ref = workerWorkspaceResultRef("claim-historical-v1");
  expect(
    await runCommandWithTimeout(["git", "-C", local, "init", "--quiet"], { timeoutMs: 10_000 }),
  ).toMatchObject({ code: 0 });
  await stageHistoricalV1Result({
    root: local,
    resultRoot: complete,
    ref,
    base,
    current,
    manifest: currentManifest,
  });
  await fs.writeFile(path.join(local, "keep.txt"), "local edit\n");

  const result = await applyStagedWorkerWorkspaceResult({
    root: local,
    stagedResultRef: ref,
    expectedBaseManifestRef: base.ref,
    journal: { load: () => undefined, begin: () => {}, commit: () => {}, abort: () => {} },
  });

  expect(result.changed).toBe(true);
  await expect(fs.readFile(path.join(local, "changed.txt"), "utf8")).resolves.toBe("worker\n");
  await expect(fs.readFile(path.join(local, "keep.txt"), "utf8")).resolves.toBe("local edit\n");
});

it("recovers a converged shipped v1 deletion above the v2 worst-case record limit", async () => {
  const local = await temporaryDirectory("workspace-staged-v1-converged-local");
  const baseManifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: null,
    entries: Array.from({ length: MAX_RECONCILIATION_ENTRIES + 1 }, (_, index) => ({
      path: `deleted-${index.toString().padStart(5, "0")}.txt`,
      type: "file" as const,
      mode: 0o644,
      size: 1,
      sha256: "a".repeat(64),
    })),
  };
  const currentManifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: null,
    entries: [],
  };
  const base = encodeManifest(baseManifest);
  const current = encodeManifest(currentManifest);
  const ref = workerWorkspaceResultRef("claim-historical-v1-converged");
  expect(
    await runCommandWithTimeout(["git", "-C", local, "init", "--quiet"], {
      timeoutMs: 10_000,
    }),
  ).toMatchObject({ code: 0 });
  await stageHistoricalV1Result({
    root: local,
    resultRoot: local,
    ref,
    base,
    current,
    manifest: currentManifest,
  });
  const begin = vi.fn();

  const result = await applyStagedWorkerWorkspaceResult({
    root: local,
    stagedResultRef: ref,
    expectedBaseManifestRef: base.ref,
    journal: { load: () => undefined, begin, commit: () => {}, abort: () => {} },
  });

  expect(result.changed).toBe(true);
  expect(result.manifest.entries).toEqual([]);
  expect(begin).toHaveBeenCalledWith(
    expect.objectContaining({
      baseEntries: [],
      appliedEntries: [],
      baseDirectories: [],
      appliedDirectories: [],
    }),
  );
}, 30_000);

it("rejects a directory-only v2 delta above the reconciliation record limit", async () => {
  const local = await temporaryDirectory("workspace-directory-entry-limit-local");
  const payload = await temporaryDirectory("workspace-directory-entry-limit-payload");
  const directoryCount = MAX_RECONCILIATION_ENTRIES / 2 + 1;
  const manifest = (prefix: string) =>
    encodeManifest({
      version: 1,
      baseCommit: null,
      entries: [],
      directories: Array.from(
        { length: directoryCount },
        (_, index) => `${prefix}-${index.toString().padStart(5, "0")}`,
      ),
    });
  const base = manifest("base");
  const current = manifest("current");

  await expect(
    workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
      root: local,
      stagingRoot: payload,
      stagedResultRef: workerWorkspaceResultRef("claim-directory-entry-limit"),
      baseManifestRef: base.ref,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    }),
  ).rejects.toThrow(`exceeds the ${MAX_RECONCILIATION_ENTRIES} entry limit`);
});

it("stages only a one-file delta for a 31,274-entry Git baseline", async () => {
  const local = await temporaryDirectory("workspace-large-baseline-local");
  const payload = await temporaryDirectory("workspace-large-baseline-payload");
  expect(
    await runCommandWithTimeout(["git", "-C", local, "init", "--quiet"], {
      timeoutMs: 10_000,
    }),
  ).toMatchObject({ code: 0 });
  const baseContent = Buffer.from("base\n");
  const currentContent = Buffer.from("worker\n");
  await Promise.all([
    fs.writeFile(path.join(local, "changed.txt"), baseContent),
    fs.writeFile(path.join(payload, "changed.txt"), currentContent),
  ]);
  const unchangedSha = createHash("sha256").update("unchanged").digest("hex");
  const unchangedEntries = Array.from({ length: 31_273 }, (_, index) => ({
    path: `file-${index.toString().padStart(5, "0")}.txt`,
    type: "file" as const,
    mode: 0o644,
    size: 9,
    sha256: unchangedSha,
  }));
  const baseManifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: "a".repeat(40),
    entries: [
      {
        path: "changed.txt",
        type: "file",
        mode: 0o644,
        size: baseContent.byteLength,
        sha256: createHash("sha256").update(baseContent).digest("hex"),
      },
      ...unchangedEntries,
    ],
  };
  const currentManifest: WorkerWorkspaceManifest = {
    ...baseManifest,
    entries: [
      {
        path: "changed.txt",
        type: "file",
        mode: 0o644,
        size: currentContent.byteLength,
        sha256: createHash("sha256").update(currentContent).digest("hex"),
      },
      ...unchangedEntries,
    ],
  };
  const base = encodeManifest(baseManifest);
  const current = encodeManifest(currentManifest);
  const ref = workerWorkspaceResultRef("claim-large-baseline");

  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: local,
    stagingRoot: payload,
    stagedResultRef: ref,
    baseManifestRef: base.ref,
    currentManifestRef: current.ref,
    baseManifestRaw: base.raw,
    currentManifestRaw: current.raw,
  });

  const tree = await runCommandWithTimeout(
    ["git", "-C", local, "ls-tree", "-r", "--name-only", ref],
    { timeoutMs: 10_000 },
  );
  expect(tree).toMatchObject({ code: 0, stdout: "changed.txt\n" });
  const message = await runCommandWithTimeout(
    ["git", "-C", local, "show", "-s", "--format=%B", ref],
    {
      timeoutMs: 10_000,
    },
  );
  expect(message.stdout).toContain("version 2\n");
  const committed = vi.fn();
  await applyStagedWorkerWorkspaceResult({
    root: local,
    stagedResultRef: ref,
    expectedBaseManifestRef: base.ref,
    journal: {
      load: () => undefined,
      begin: () => {},
      commit: committed,
      abort: () => {},
    },
  });
  expect(committed).toHaveBeenCalledOnce();
  await expect(fs.readFile(path.join(local, "changed.txt"), "utf8")).resolves.toBe("worker\n");

  const unchangedRef = workerWorkspaceResultRef("claim-large-baseline-unchanged");
  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: local,
    stagingRoot: payload,
    stagedResultRef: unchangedRef,
    baseManifestRef: current.ref,
    currentManifestRef: current.ref,
    baseManifestRaw: current.raw,
    currentManifestRaw: current.raw,
  });
  const unchangedTree = await runCommandWithTimeout(
    ["git", "-C", local, "ls-tree", "-r", "--name-only", unchangedRef],
    { timeoutMs: 10_000 },
  );
  expect(unchangedTree).toMatchObject({ code: 0, stdout: "" });
  const unchanged = await applyStagedWorkerWorkspaceResult({
    root: local,
    stagedResultRef: unchangedRef,
    expectedBaseManifestRef: current.ref,
    journal: {
      load: () => undefined,
      begin: () => {},
      commit: () => {},
      abort: () => {},
    },
  });
  expect(unchanged.changed).toBe(false);
});
