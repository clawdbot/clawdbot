import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDirFetch } from "../node-host/dir-fetch.js";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

const requireRecord = createRequireRecord("object", "label-not-object");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createRealDirFetchContext(input: {
  approved: string;
  maxBytes: number;
  requested: string;
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
        "node-1": { ask: "on-miss", followSymlinks: true, maxBytes: input.maxBytes },
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
  });
});
