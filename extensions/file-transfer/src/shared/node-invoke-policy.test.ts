import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
// File Transfer tests cover node invoke policy plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";
import {
  EXISTING_BINDING,
  WRITE_BINDING,
  createCtx,
  expectRecordFields,
  expectResultFields,
  requireInvokeParams,
  requireRecord,
} from "./node-invoke-policy.test-support.js";
import { persistLiteralGrant } from "./policy.js";

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

vi.mock("./policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policy.js")>();
  return {
    ...actual,
    persistLiteralGrant: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  vi.mocked(persistLiteralGrant).mockReset();
  vi.mocked(persistLiteralGrant).mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("./audit.js");
  vi.doUnmock("./policy.js");
  vi.resetModules();
});

describe("file-transfer node invoke policy", () => {
  it("injects policy-owned limits before invoking the node", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "file.fetch",
      params: { path: "/tmp/file.txt", maxBytes: 4096, followSymlinks: true },
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenNthCalledWith(1, {
      params: {
        path: "/tmp/file.txt",
        maxBytes: 512,
        followSymlinks: false,
        preflightOnly: true,
      },
    });
    expect(invokeNode).toHaveBeenNthCalledWith(2, {
      params: {
        path: "/tmp/file.txt",
        maxBytes: 512,
        followSymlinks: false,
        expectedCanonicalPath: "/tmp/file.txt",
        expectedBinding: EXISTING_BINDING,
      },
    });
  });

  it("normalizes string maxBytes before invoking the node", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/file.txt", maxBytes: "1024" },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowReadPaths: ["/tmp/**"],
          },
        },
      },
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenNthCalledWith(1, {
      params: {
        path: "/tmp/file.txt",
        maxBytes: 1024,
        followSymlinks: false,
        preflightOnly: true,
      },
    });
  });

  it("rejects malformed maxBytes before invoking the node", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/file.txt", maxBytes: "1024.5" },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, {
      ok: false,
      code: "INVALID_PARAMS",
      message: "maxBytes must be a positive integer",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("rejects malformed maxBytes before requesting approval", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision: "allow-always" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt", maxBytes: "1024.5" },
      pluginConfig: {
        nodes: {
          "node-1": {
            ask: "on-miss",
            allowReadPaths: ["/allowed/**"],
          },
        },
      },
      approvals,
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, {
      ok: false,
      code: "INVALID_PARAMS",
      message: "maxBytes must be a positive integer",
    });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("denies raw node.invoke before the node when plugin policy is missing", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({ pluginConfig: {} });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "NO_POLICY" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it.each(["allow-once", "allow-always"] as const)(
    "uses exact %s plugin approval once across preflight and final invoke",
    async (decision) => {
      const policy = createFileTransferNodeInvokePolicy();
      const approvals = {
        request: vi.fn(async (_request: unknown) => ({ id: "approval-1", decision })),
      };
      const { ctx, invokeNode } = createCtx({
        params: { path: "/tmp/new.txt" },
        pluginConfig: {
          nodes: {
            "node-1": {
              ask: "on-miss",
              allowReadPaths: ["/allowed/**"],
              maxBytes: 256,
              followSymlinks: true,
            },
          },
        },
        approvals,
      });

      const result = await policy.handle(ctx);

      expect(result.ok).toBe(true);
      expect(approvals.request).toHaveBeenCalledTimes(1);
      expect(invokeNode).toHaveBeenCalledTimes(2);
      const approvalCalls = approvals.request.mock.calls as unknown[][];
      const approvalRequest = requireRecord(approvalCalls[0]?.[0], "approval request");
      expectRecordFields(approvalRequest, {
        title: "Read file: /tmp/new.txt",
        severity: "info",
        toolName: "file.fetch",
      });
      expect(approvalRequest.description).toContain(
        '"allow-always" saves this exact command and path for this node',
      );
      expect(invokeNode).toHaveBeenNthCalledWith(1, {
        params: {
          path: "/tmp/new.txt",
          followSymlinks: true,
          maxBytes: 256,
          preflightOnly: true,
        },
      });
      expect(invokeNode).toHaveBeenNthCalledWith(2, {
        params: {
          path: "/tmp/new.txt",
          followSymlinks: true,
          maxBytes: 256,
          expectedCanonicalPath: "/tmp/new.txt",
          expectedBinding: EXISTING_BINDING,
        },
      });
    },
  );

  it("persists allow-always only after the canonical result succeeds", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision: "allow-always" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new-*.txt" },
      pluginConfig: { nodes: { "node-1": { ask: "on-miss" } } },
      approvals,
    });
    invokeNode.mockResolvedValue({
      ok: true,
      payload: {
        ok: true,
        binding: EXISTING_BINDING,
        path: "/private/tmp/new-*.txt",
        size: 1,
        sha256: "a".repeat(64),
      },
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(persistLiteralGrant).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "file.fetch",
      requestedPath: "/tmp/new-*.txt",
      canonicalPath: "/private/tmp/new-*.txt",
      pendingReapprovalSelector: undefined,
    });
  });

  it("returns an actionable warning when the operation succeeds but persistence fails", async () => {
    vi.mocked(persistLiteralGrant).mockRejectedValueOnce(new Error("config changed"));
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision: "allow-always" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: { nodes: { "node-1": { ask: "on-miss" } } },
      approvals,
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(requireRecord(requireRecord(result, "result").payload, "payload")).toHaveProperty(
      "standingApprovalWarning",
    );
  });

  it("reuses an exact literal grant and reapproves canonical drift", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-2", decision: "allow-always" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/report-*.txt" },
      pluginConfig: {
        policyVersion: 2,
        nodes: { "node-1": { ask: "on-miss" } },
        literalGrants: [
          {
            nodeId: "node-1",
            command: "file.fetch",
            requestedPath: "/tmp/report-*.txt",
            canonicalPath: "/tmp/report-*.txt",
          },
        ],
      },
      approvals,
    });

    expect((await policy.handle(ctx)).ok).toBe(true);
    expect(approvals.request).not.toHaveBeenCalled();

    invokeNode.mockReset();
    invokeNode.mockResolvedValue({
      ok: true,
      payload: { ok: true, binding: EXISTING_BINDING, path: "/tmp/other.txt" },
    });
    expect((await policy.handle(ctx)).ok).toBe(true);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(persistLiteralGrant).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "file.fetch",
      requestedPath: "/tmp/report-*.txt",
      canonicalPath: "/tmp/other.txt",
      pendingReapprovalSelector: undefined,
    });
  });

  it.each([
    {
      label: "explicit deny",
      decision: "deny",
      code: "APPROVAL_DENIED",
      message: "file.fetch APPROVAL_DENIED: operator denied the prompt",
    },
    {
      label: "null decision",
      decision: null,
      code: "APPROVAL_UNAVAILABLE",
      message:
        "file.fetch APPROVAL_UNAVAILABLE: no operator client connected to approve the request",
    },
    {
      label: "undefined decision",
      decision: undefined,
      code: "APPROVAL_UNAVAILABLE",
      message:
        "file.fetch APPROVAL_UNAVAILABLE: no operator client connected to approve the request",
    },
    {
      label: "arbitrary truthy string",
      decision: "accept",
      code: "APPROVAL_DENIED",
      message: "file.fetch APPROVAL_DENIED: invalid approval decision",
    },
    {
      label: "arbitrary truthy object",
      decision: { action: "accept" },
      code: "APPROVAL_DENIED",
      message: "file.fetch APPROVAL_DENIED: invalid approval decision",
    },
  ])("fails closed for $label", async ({ decision, code, message }) => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision })),
    } as unknown as NonNullable<OpenClawPluginNodeInvokePolicyContext["approvals"]>;
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: {
        nodes: {
          "node-1": {
            ask: "on-miss",
            allowReadPaths: ["/allowed/**"],
          },
        },
      },
      approvals,
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code, message });
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("marks node transport failures as unavailable", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/file.txt" },
    });
    invokeNode.mockResolvedValueOnce({
      ok: false,
      code: "TIMEOUT",
      message: "node timed out",
      details: { nodeError: { code: "TIMEOUT" } },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, {
      ok: false,
      code: "TIMEOUT",
      unavailable: true,
      details: { nodeError: { code: "TIMEOUT" } },
    });
  });

  it("checks file.fetch canonical policy before requesting bytes", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/link.txt" },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        binding: EXISTING_BINDING,
        path: "/etc/passwd",
        size: 1,
        sha256: "a".repeat(64),
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "SYMLINK_TARGET_DENIED" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      path: "/tmp/link.txt",
      followSymlinks: false,
      preflightOnly: true,
    });
  });

  it("continues file.fetch after preflight without forwarding caller preflightOnly", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/file.txt", preflightOnly: true },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      path: "/tmp/file.txt",
      preflightOnly: true,
    });
    expect(requireInvokeParams(invokeNode, 1).preflightOnly).toBeUndefined();
  });

  it("checks file.write canonical policy before the mutating node call", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "file.write",
      params: {
        path: "/tmp/link/out.txt",
        contentBase64: Buffer.from("payload").toString("base64"),
        createParents: true,
      },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowWritePaths: ["/tmp/**"],
            followSymlinks: true,
          },
        },
      },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        binding: WRITE_BINDING,
        path: "/etc/out.txt",
        size: 7,
        sha256: "b".repeat(64),
        overwritten: false,
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "SYMLINK_TARGET_DENIED" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      path: "/tmp/link/out.txt",
      followSymlinks: true,
      preflightOnly: true,
    });
  });
});
