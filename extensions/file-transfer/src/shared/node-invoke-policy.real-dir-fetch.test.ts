import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDirFetch } from "../node-host/dir-fetch.js";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";
import * as filePolicy from "./policy.js";

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

const requireRecord = createRequireRecord("object", "label-not-object");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createRealDirFetchContext(input: {
  approved: string;
  maxBytes: number;
  requested: string;
  denyPaths?: string[];
}) {
  const approvals = {
    request: vi.fn(async () => ({ id: "approval-1", decision: "deny" as const })),
  };
  const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(
    async ({ params } = {}) => ({
      ok: true,
      payload: await handleDirFetch((params ?? {}) as Parameters<typeof handleDirFetch>[0]),
    }),
  );
  const ctx: OpenClawPluginNodeInvokePolicyContext = {
    nodeId: "node-1",
    command: "dir.fetch",
    params: { path: input.requested, maxBytes: input.maxBytes },
    config: {},
    pluginConfig: {
      policyVersion: 2,
      nodes: {
        "node-1": {
          ask: "on-miss",
          followSymlinks: true,
          maxBytes: input.maxBytes,
          denyPaths: input.denyPaths,
        },
      },
      literalGrants: [
        {
          nodeId: "node-1",
          command: "dir.fetch",
          requestedPath: input.requested,
          canonicalPath: input.approved,
        },
      ],
    },
    node: { nodeId: "node-1", displayName: "Node One" },
    approvals,
    invokeNode,
  };
  return { approvals, ctx, invokeNode };
}

async function extractFetchedArchive(payload: Record<string, unknown>, tempRoot: string) {
  if (typeof payload.tarBase64 !== "string") {
    throw new Error("missing archive bytes");
  }
  const bytes = Buffer.from(payload.tarBase64, "base64");
  expect(bytes.byteLength).toBe(payload.tarBytes);
  expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(payload.sha256);
  const archivePath = path.join(tempRoot, "transfer.tar.gz");
  const destDir = path.join(tempRoot, "extracted");
  await fs.writeFile(archivePath, bytes, { mode: 0o600 });
  await fs.mkdir(destDir, { mode: 0o700 });
  await extractArchive({
    archivePath,
    destDir,
    kind: "tar",
    tarGzip: true,
    timeoutMs: 60_000,
    entryModes: "clamp",
    entryFilter: ({ kind }) => (kind === "file" || kind === "directory" ? "extract" : "skip"),
    onFiltered: "reject-archive",
    limits: {
      maxArchiveBytes: 16 * 1024 * 1024,
      maxEntries: 5000,
      maxExtractedBytes: 64 * 1024 * 1024,
      maxEntryBytes: 16 * 1024 * 1024,
    },
  });
  return destDir;
}

function firstInvokeParams(
  invokeNode: ReturnType<typeof vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>>,
) {
  const request = requireRecord(invokeNode.mock.calls[0]?.[0], "invoke request");
  return requireRecord(request.params, "invoke params");
}

describe.runIf(process.platform !== "win32")("file-transfer real dir.fetch policy", () => {
  it("rejects a retargeted literal grant before archive preflight I/O", async () => {
    const tmpRoot = tempDirs.make("file-transfer-policy-");
    const approved = path.join(tmpRoot, "approved");
    const replacement = path.join(tmpRoot, "replacement");
    const requested = path.join(tmpRoot, "current");
    await fs.mkdir(approved);
    await fs.mkdir(replacement);
    await fs.writeFile(path.join(replacement, "secret.bin"), crypto.randomBytes(4096));
    await fs.symlink(replacement, requested);
    const { approvals, ctx, invokeNode } = await createRealDirFetchContext({
      approved,
      maxBytes: 1,
      requested,
    });

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    expect(result).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(firstInvokeParams(invokeNode).expectedCanonicalPath).toBe(approved);
  });

  it("archives an unchanged literal target through the real node handler", async () => {
    const tmpRoot = tempDirs.make("file-transfer-policy-");
    const approved = path.join(tmpRoot, "approved");
    const requested = path.join(tmpRoot, "current");
    await fs.mkdir(approved);
    await fs.writeFile(path.join(approved, "allowed.txt"), "allowed");
    await fs.symlink(approved, requested);
    const { approvals, ctx, invokeNode } = await createRealDirFetchContext({
      approved,
      maxBytes: 1024 * 1024,
      requested,
    });

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    expect(result).toMatchObject({ ok: true });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(firstInvokeParams(invokeNode).expectedCanonicalPath).toBe(approved);
    const payload = requireRecord(requireRecord(result, "result").payload, "payload");
    expect(payload.tarBytes).toBeGreaterThan(0);
    const destDir = await extractFetchedArchive(payload, tmpRoot);
    expect(await fs.readFile(path.join(destDir, "allowed.txt"), "utf8")).toBe("allowed");
  });

  it.each([
    {
      name: "denies the real LF descendant in source preflight",
      deniedName: "line\n.txt",
      denied: true,
    },
    {
      name: "preserves LF identity through producer, policy, and extraction",
      deniedName: "line/n.txt",
      denied: false,
    },
  ])("$name", async ({ deniedName, denied }) => {
    const tmpRoot = await fs.realpath(tempDirs.make("file-transfer-identity-"));
    const source = path.join(tmpRoot, "source");
    const filename = "line\n.txt";
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, filename), "literal LF payload");
    const { ctx, invokeNode } = await createRealDirFetchContext({
      approved: source,
      requested: source,
      maxBytes: 1024 * 1024,
      // A deny for the display alias must not deny the actual LF filename.
      denyPaths: [path.join(source, deniedName)],
    });

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    if (denied) {
      expect(result).toMatchObject({
        ok: false,
        code: "PATH_POLICY_DENIED",
        details: { path: path.join(source, filename) },
      });
      expect(invokeNode).toHaveBeenCalledOnce();
      return;
    }
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(result, result.ok ? undefined : result.message).toMatchObject({ ok: true });
    const payload = requireRecord(requireRecord(result, "result").payload, "payload");
    expect(payload.entries).toContain(filename);
    expect(payload.entries).not.toContain("line/n.txt");
    const destDir = await extractFetchedArchive(payload, tmpRoot);
    expect(await fs.readFile(path.join(destDir, filename), "utf8")).toBe("literal LF payload");
    await expect(fs.stat(path.join(destDir, "line", "n.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform === "darwin")(
    "authorizes every materialized member from the real macOS metadata producer",
    async () => {
      const tmpRoot = await fs.realpath(tempDirs.make("file-transfer-identity-"));
      const source = path.join(tmpRoot, "source");
      await fs.mkdir(source);
      const sourceFile = path.join(source, "note.txt");
      await fs.writeFile(sourceFile, "synthetic file payload");
      execFileSync("/usr/bin/xattr", [
        "-w",
        "user.openclaw-fixture",
        "synthetic metadata",
        sourceFile,
      ]);
      const { ctx } = await createRealDirFetchContext({
        approved: source,
        requested: source,
        maxBytes: 1024 * 1024,
      });
      const evaluated = vi.spyOn(filePolicy, "evaluateFilePolicyConstraints");
      try {
        const result = await createFileTransferNodeInvokePolicy().handle(ctx);
        expect(result).toMatchObject({ ok: true });
        const payload = requireRecord(requireRecord(result, "result").payload, "payload");
        const destDir = await extractFetchedArchive(payload, tmpRoot);
        const materialized = (await fs.readdir(destDir)).toSorted();
        expect(materialized).toContain("._note.txt");
        expect(await fs.readFile(path.join(destDir, "note.txt"), "utf8")).toBe(
          "synthetic file payload",
        );
        const policyPaths = new Set(evaluated.mock.calls.map(([input]) => input.path));
        expect(policyPaths).toEqual(
          new Set([source, ...materialized.map((name) => path.join(source, name))]),
        );
        expect(payload.entries).toEqual(materialized);
      } finally {
        evaluated.mockRestore();
      }
    },
  );
});
