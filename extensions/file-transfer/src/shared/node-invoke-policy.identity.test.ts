import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

const requireRecord = createRequireRecord("object", "label-not-object");
const WRITE_BINDING = {
  kind: "write",
  anchorPath: "/private/tmp",
  anchorDevice: "1",
  anchorInode: "2",
} as const;

function invokeParams(
  invokeNode: ReturnType<typeof vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>>,
  index: number,
) {
  return requireRecord(requireRecord(invokeNode.mock.calls[index]?.[0], "invoke").params, "params");
}

describe("file-transfer preflight identity", () => {
  it("fails closed when a node preflight omits filesystem identity", async () => {
    const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
      ok: true,
      payload: { ok: true, path: "/tmp/file.txt", size: 1 },
    }));
    const ctx: OpenClawPluginNodeInvokePolicyContext = {
      nodeId: "node-1",
      command: "file.fetch",
      params: { path: "/tmp/file.txt" },
      config: {},
      pluginConfig: {
        policyVersion: 2,
        nodes: { "node-1": { allowReadPaths: ["/tmp/**"] } },
      },
      node: { nodeId: "node-1" },
      invokeNode,
    };

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    expect(result).toMatchObject({ ok: false, code: "FILESYSTEM_IDENTITY_MISSING" });
    expect(invokeNode).toHaveBeenCalledOnce();
  });

  it("forwards a write preflight binding only to the final effect", async () => {
    const invokeNode = vi
      .fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          binding: WRITE_BINDING,
          path: "/private/tmp/out.txt",
          size: 7,
          sha256: "b".repeat(64),
          overwritten: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          binding: { kind: "existing", device: "1", inode: "3" },
          path: "/private/tmp/out.txt",
          size: 7,
          sha256: "b".repeat(64),
          overwritten: false,
        },
      });
    const ctx: OpenClawPluginNodeInvokePolicyContext = {
      nodeId: "node-1",
      command: "file.write",
      params: {
        path: "/tmp/link/out.txt",
        contentBase64: Buffer.from("payload").toString("base64"),
        createParents: true,
        preflightOnly: true,
      },
      config: {},
      pluginConfig: {
        policyVersion: 2,
        nodes: {
          "node-1": {
            allowWritePaths: ["/tmp/**", "/private/tmp/**"],
            followSymlinks: true,
          },
        },
      },
      node: { nodeId: "node-1" },
      invokeNode,
    };

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(invokeParams(invokeNode, 0).expectedBinding).toBeUndefined();
    expect(invokeParams(invokeNode, 1)).toMatchObject({
      expectedBinding: WRITE_BINDING,
      expectedCanonicalPath: "/private/tmp/out.txt",
    });
    expect(invokeParams(invokeNode, 1).preflightOnly).toBeUndefined();
  });
});
