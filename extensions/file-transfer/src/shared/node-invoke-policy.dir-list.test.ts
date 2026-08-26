import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

const requireRecord = createRequireRecord("object", "label-not-object");
const EXISTING_BINDING = { kind: "existing", device: "1", inode: "2" } as const;

describe("file-transfer dir.list policy", () => {
  it("reapproves a stale grant before listing and binds the retry", async () => {
    const events: string[] = [];
    const approvals = {
      request: vi.fn(async () => {
        events.push("approval");
        return { id: "approval-1", decision: "allow-once" as const };
      }),
    };
    const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(
      async ({ params } = {}) => {
        const record = requireRecord(params, "invoke params");
        events.push(record.preflightOnly === true ? "preflight" : "list");
        if (record.preflightOnly === true && record.expectedCanonicalPath === "/tmp/old-project") {
          return {
            ok: true,
            payload: {
              ok: false,
              code: "CANONICAL_PATH_CHANGED",
              message: "canonical path differs from the authorized target",
              canonicalPath: "/tmp/new-project",
            },
          };
        }
        return {
          ok: true,
          payload: { ok: true, binding: EXISTING_BINDING, path: "/tmp/new-project", entries: [] },
        };
      },
    );
    const ctx: OpenClawPluginNodeInvokePolicyContext = {
      nodeId: "node-1",
      command: "dir.list",
      params: { path: "/tmp/project", expectedCanonicalPath: "/tmp/injected" },
      config: {},
      pluginConfig: {
        policyVersion: 2,
        nodes: { "node-1": { ask: "on-miss", followSymlinks: true } },
        literalGrants: [
          {
            nodeId: "node-1",
            command: "dir.list",
            requestedPath: "/tmp/project",
            canonicalPath: "/tmp/old-project",
          },
        ],
      },
      node: { nodeId: "node-1", displayName: "Node One" },
      approvals,
      invokeNode,
    };

    expect((await createFileTransferNodeInvokePolicy().handle(ctx)).ok).toBe(true);
    expect(events).toEqual(["preflight", "approval", "preflight", "list"]);
    expect(invokeNode).toHaveBeenNthCalledWith(1, {
      params: {
        path: "/tmp/project",
        followSymlinks: true,
        preflightOnly: true,
        expectedCanonicalPath: "/tmp/old-project",
      },
    });
    expect(invokeNode).toHaveBeenNthCalledWith(2, {
      params: {
        path: "/tmp/project",
        followSymlinks: true,
        preflightOnly: true,
        expectedCanonicalPath: "/tmp/new-project",
      },
    });
    expect(invokeNode).toHaveBeenNthCalledWith(3, {
      params: {
        path: "/tmp/project",
        followSymlinks: true,
        expectedCanonicalPath: "/tmp/new-project",
        expectedBinding: EXISTING_BINDING,
      },
    });
  });
});
