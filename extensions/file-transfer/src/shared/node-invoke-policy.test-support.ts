// Shared File Transfer node-invoke policy fixtures for split test files.
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";

export function tarEntries(
  entries: Record<string, string>,
  options?: { producerRoot?: boolean },
): string {
  const blocks: Buffer[] = [];
  if (options?.producerRoot) {
    blocks.push(createTarDirHeader("./"));
  }
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

export function archiveMetadata(tarBase64: string): { tarBytes: number; sha256: string } {
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

function createTarFileHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(" ", 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createTarDirHeader(name: string): Buffer {
  return createTarFileHeader(name, 0, "5");
}

export function createCtx(overrides: {
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
        binding:
          (overrides.command ?? "file.fetch") === "file.write" ? WRITE_BINDING : EXISTING_BINDING,
      },
    }),
  );
  return {
    ctx: {
      nodeId: "node-1",
      command: overrides.command ?? "file.fetch",
      params: overrides.params ?? { path: "/tmp/file.txt", maxBytes: 1024 },
      config: {},
      pluginConfig: overrides.pluginConfig
        ? { policyVersion: 2, ...overrides.pluginConfig }
        : {
            policyVersion: 2,
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

export const requireRecord = createRequireRecord("object", "label-not-object");
export const EXISTING_BINDING = { kind: "existing", device: "1", inode: "2" } as const;
export const WRITE_BINDING = {
  kind: "write",
  anchorPath: "/tmp",
  anchorDevice: "1",
  anchorInode: "2",
} as const;

export function mockDirFetchArchive(
  invokeNode: ReturnType<typeof createCtx>["invokeNode"],
  root: string,
  entries: Record<string, string>,
  options?: { producerRoot?: boolean },
) {
  const tarBase64 = tarEntries(entries, options);
  invokeNode
    .mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        binding: EXISTING_BINDING,
        path: root,
        entries: ["ok.txt"],
        fileCount: 1,
        preflightOnly: true,
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        binding: EXISTING_BINDING,
        path: root,
        tarBase64,
        ...archiveMetadata(tarBase64),
        fileCount: Object.keys(entries).length,
      },
    });
}

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function expectResultFields(result: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(result, "policy result"), fields);
}

export function requireInvokeParams(
  invokeNode: ReturnType<typeof vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>>,
  callIndex: number,
) {
  const call = (invokeNode.mock.calls as unknown[][])[callIndex]?.[0];
  const request = requireRecord(call, `invoke call ${callIndex + 1}`);
  return requireRecord(request.params, `invoke call ${callIndex + 1} params`);
}
