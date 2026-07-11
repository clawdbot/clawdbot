// File Transfer tests cover node invoke policy plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { appendFileTransferAudit } from "./audit.js";
import { createFileTransferNodeInvokePolicy, testing } from "./node-invoke-policy.js";

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

vi.mock("./policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policy.js")>();
  return {
    ...actual,
    persistAllowAlways: vi.fn(async () => undefined),
  };
});

const tmpRoots: string[] = [];
const testUnlessWindows = process.platform === "win32" ? it.skip : it;

afterEach(async () => {
  await Promise.all(tmpRoots.map((tmpRoot) => fs.rm(tmpRoot, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

afterAll(() => {
  vi.doUnmock("./audit.js");
  vi.doUnmock("./policy.js");
  vi.resetModules();
});

function tarEntries(entries: Record<string, string>): string {
  const blocks: Buffer[] = [];
  for (const [relPath, contents] of Object.entries(entries)) {
    const payload = Buffer.from(contents);
    blocks.push(createTarFileHeader(relPath, payload.byteLength), payload);
    const padding = (512 - (payload.byteLength % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks)).toString("base64");
}

function archiveMetadata(tarBase64: string): { tarBytes: number; sha256: string } {
  const buffer = Buffer.from(tarBase64, "base64");
  return {
    tarBytes: buffer.byteLength,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value.slice(0, length), offset, length, "utf8");
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(`${text}\0`.slice(-length), offset, length, "ascii");
}

function createTarFileHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(" ", 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createCtx(overrides: {
  command?: string;
  params?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  approvals?: OpenClawPluginNodeInvokePolicyContext["approvals"];
}) {
  const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(
    async ({
      params,
    }: Parameters<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>[0] = {}) => ({
      ok: true,
      payload: {
        ok: true,
        path:
          typeof (params as { path?: unknown } | undefined)?.path === "string"
            ? (params as { path: string }).path
            : "/tmp/file.txt",
        size: 1,
        sha256: "a".repeat(64),
      },
    }),
  );
  return {
    ctx: {
      nodeId: "node-1",
      command: overrides.command ?? "file.fetch",
      params: overrides.params ?? { path: "/tmp/file.txt", maxBytes: 1024 },
      config: {},
      pluginConfig: overrides.pluginConfig ?? {
        nodes: {
          "node-1": {
            allowReadPaths: ["/tmp/**"],
            allowWritePaths: ["/tmp/**"],
            maxBytes: 512,
          },
        },
      },
      node: { nodeId: "node-1", displayName: "Node One" },
      ...(overrides.approvals ? { approvals: overrides.approvals } : {}),
      invokeNode,
    },
    invokeNode,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectResultFields(result: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(result, "policy result"), fields);
}

function requireInvokeParams(
  invokeNode: ReturnType<typeof vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>>,
  callIndex: number,
) {
  const call = (invokeNode.mock.calls as unknown[][])[callIndex]?.[0];
  const request = requireRecord(call, `invoke call ${callIndex + 1}`);
  return requireRecord(request.params, `invoke call ${callIndex + 1} params`);
}

describe("file-transfer node invoke policy", () => {
  it("maps only transfer payload sizes into audit records", () => {
    expect(testing.readAuditSizeBytes("file.fetch", { size: 3 })).toBe(3);
    expect(testing.readAuditSizeBytes("file.write", { size: 4 })).toBe(4);
    expect(testing.readAuditSizeBytes("dir.fetch", { tarBytes: 999 }, 5)).toBe(5);
    expect(testing.readAuditSizeBytes("dir.list", { size: 6 })).toBeUndefined();
  });

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

  it("uses plugin approvals for ask-on-miss before invoking the node", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision: "allow-once" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: {
        nodes: {
          "node-1": {
            ask: "on-miss",
            allowReadPaths: ["/allowed/**"],
            maxBytes: 256,
          },
        },
      },
      approvals,
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    const approvalCalls = approvals.request.mock.calls as unknown[][];
    const approvalRequest = requireRecord(approvalCalls[0]?.[0], "approval request");
    expectRecordFields(approvalRequest, {
      title: "Read file: /tmp/new.txt",
      severity: "info",
      toolName: "file.fetch",
    });
    expect(invokeNode).toHaveBeenNthCalledWith(1, {
      params: {
        path: "/tmp/new.txt",
        followSymlinks: false,
        maxBytes: 256,
        preflightOnly: true,
      },
    });
    expect(invokeNode).toHaveBeenNthCalledWith(2, {
      params: {
        path: "/tmp/new.txt",
        followSymlinks: false,
        maxBytes: 256,
      },
    });
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

  it("continues file.write after preflight without forwarding caller preflightOnly", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "file.write",
      params: {
        path: "/tmp/link/out.txt",
        contentBase64: Buffer.from("payload").toString("base64"),
        createParents: true,
        preflightOnly: true,
      },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowWritePaths: ["/tmp/**", "/private/tmp/**"],
            followSymlinks: true,
          },
        },
      },
    });
    invokeNode
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
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
          path: "/private/tmp/out.txt",
          size: 7,
          sha256: "b".repeat(64),
          overwritten: false,
        },
      });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(requireInvokeParams(invokeNode, 0).preflightOnly).toBe(true);
    expect(requireInvokeParams(invokeNode, 1).preflightOnly).toBeUndefined();
  });

  it("checks every dir.fetch preflight entry before requesting the archive", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "dir.fetch",
      params: { path: "/home/me" },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowReadPaths: ["/home/me", "/home/me/**"],
            denyPaths: ["**/.ssh/**"],
          },
        },
      },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        path: "/home/me",
        entries: ["ok.txt", ".ssh/id_rsa"],
        fileCount: 2,
        preflightOnly: true,
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PATH_POLICY_DENIED" });
    expect(
      requireRecord(requireRecord(result, "policy result").details, "result details").path,
    ).toBe("/home/me/.ssh/id_rsa");
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      path: "/home/me",
      preflightOnly: true,
    });
  });

  it("rejects dir.fetch preflight responses without an entry list", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "dir.fetch",
      params: { path: "/home/me" },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowReadPaths: ["/home/me", "/home/me/**"],
          },
        },
      },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        path: "/home/me",
        fileCount: 2,
        preflightOnly: true,
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PREFLIGHT_ENTRIES_MISSING" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid dir.fetch preflight entries before requesting the archive", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "dir.fetch",
      params: { path: "/home/me" },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowReadPaths: ["/home/me", "/home/me/**"],
          },
        },
      },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        path: "/home/me",
        entries: ["ok.txt", "/etc/passwd"],
        fileCount: 2,
        preflightOnly: true,
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PREFLIGHT_ENTRY_INVALID" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized dir.fetch preflight entry lists before requesting the archive", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const entries = Array.from({ length: 5001 }, (_, index) => `file-${index}.txt`);
    const { ctx, invokeNode } = createCtx({
      command: "dir.fetch",
      params: { path: "/home/me" },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowReadPaths: ["/home/me", "/home/me/**"],
          },
        },
      },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        path: "/home/me",
        entries,
        fileCount: entries.length,
        preflightOnly: true,
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PREFLIGHT_ENTRIES_TOO_MANY" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });

  testUnlessWindows(
    "continues dir.fetch after preflight without forwarding caller preflightOnly",
    async () => {
      const policy = createFileTransferNodeInvokePolicy();
      const tarBase64 = tarEntries({
        "a.txt": "a",
        "sub/b.txt": "b",
      });
      const { ctx, invokeNode } = createCtx({
        command: "dir.fetch",
        params: { path: "/tmp/project", preflightOnly: true },
      });
      invokeNode
        .mockResolvedValueOnce({
          ok: true,
          payload: {
            ok: true,
            path: "/tmp/project",
            entries: ["a.txt", "sub/b.txt"],
            fileCount: 2,
            preflightOnly: true,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          payload: {
            ok: true,
            path: "/tmp/project",
            tarBase64,
            ...archiveMetadata(tarBase64),
            fileCount: 2,
            entries: ["a.txt", "sub/b.txt"],
          },
        });

      const result = await policy.handle(ctx);

      expectResultFields(result, { ok: true });
      expect(invokeNode).toHaveBeenCalledTimes(2);
      expectRecordFields(requireInvokeParams(invokeNode, 0), {
        path: "/tmp/project",
        preflightOnly: true,
      });
      expect(requireInvokeParams(invokeNode, 1).preflightOnly).toBeUndefined();
    },
  );

  testUnlessWindows("audits dir.fetch archive bytes after a successful transfer", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const tarBase64 = tarEntries({
      "a.txt": "a",
    });
    const { tarBytes, sha256 } = archiveMetadata(tarBase64);
    const { ctx } = createCtx({
      command: "dir.fetch",
      params: { path: "/tmp/project" },
    });
    const invokeNode = vi.mocked(ctx.invokeNode);
    invokeNode
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          entries: ["a.txt"],
          fileCount: 1,
          preflightOnly: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          tarBase64,
          tarBytes,
          sha256,
          fileCount: 1,
        },
      });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: true });
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "dir.fetch",
        requestedPath: "/tmp/project",
        canonicalPath: "/tmp/project",
        decision: "allowed",
        sizeBytes: tarBytes,
        sha256,
      }),
    );
  });

  testUnlessWindows("rejects mismatched dir.fetch archive integrity metadata", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const tarBase64 = tarEntries({ "a.txt": "a" });
    const { ctx, invokeNode } = createCtx({
      command: "dir.fetch",
      params: { path: "/tmp/project" },
    });
    invokeNode
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          entries: ["a.txt"],
          fileCount: 1,
          preflightOnly: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          tarBase64,
          tarBytes: 1,
          sha256: "c".repeat(64),
          fileCount: 1,
        },
      });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "ARCHIVE_SIZE_MISMATCH" });
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "dir.fetch",
        decision: "error",
        errorCode: "ARCHIVE_SIZE_MISMATCH",
      }),
    );
  });

  testUnlessWindows(
    "checks final dir.fetch archive entries before returning the archive",
    async () => {
      const policy = createFileTransferNodeInvokePolicy();
      const tarBase64 = tarEntries({
        "ok.txt": "ok",
        ".ssh/id_rsa": "secret",
      });
      const { ctx, invokeNode } = createCtx({
        command: "dir.fetch",
        params: { path: "/home/me" },
        pluginConfig: {
          nodes: {
            "node-1": {
              allowReadPaths: ["/home/me", "/home/me/**"],
              denyPaths: ["**/.ssh/**"],
            },
          },
        },
      });
      invokeNode
        .mockResolvedValueOnce({
          ok: true,
          payload: {
            ok: true,
            path: "/home/me",
            entries: ["ok.txt"],
            fileCount: 1,
            preflightOnly: true,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          payload: {
            ok: true,
            path: "/home/me",
            tarBase64,
            ...archiveMetadata(tarBase64),
            fileCount: 2,
          },
        });

      const result = await policy.handle(ctx);

      expectResultFields(result, { ok: false, code: "PATH_POLICY_DENIED" });
      expect(
        requireRecord(requireRecord(result, "policy result").details, "result details").path,
      ).toBe("/home/me/.ssh/id_rsa");
      expect(invokeNode).toHaveBeenCalledTimes(2);
    },
  );

  testUnlessWindows("rejects oversized final dir.fetch archive entry lists", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const tarBase64 = tarEntries(
      Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`file-${index}.txt`, "x"])),
    );
    const { ctx, invokeNode } = createCtx({
      command: "dir.fetch",
      params: { path: "/tmp/project" },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowReadPaths: ["/tmp/project", "/tmp/project/**"],
          },
        },
      },
    });
    invokeNode
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          entries: ["file-0.txt"],
          fileCount: 1,
          preflightOnly: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          tarBase64,
          ...archiveMetadata(tarBase64),
          fileCount: 5001,
        },
      });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "ARCHIVE_ENTRIES_TOO_MANY" });
    expect(invokeNode).toHaveBeenCalledTimes(2);
  });

  it("rejects final dir.fetch archive responses without readable archive entries", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "dir.fetch",
      params: { path: "/tmp/project" },
    });
    invokeNode
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          entries: ["a.txt"],
          fileCount: 1,
          preflightOnly: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          ok: true,
          path: "/tmp/project",
          tarBytes: 7,
          sha256: "c".repeat(64),
          fileCount: 1,
        },
      });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "ARCHIVE_ENTRIES_MISSING" });
    expect(invokeNode).toHaveBeenCalledTimes(2);
  });
});
