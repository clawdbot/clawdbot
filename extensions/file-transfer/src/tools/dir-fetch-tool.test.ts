// File Transfer tests cover dir fetch tar validation through the tool boundary.
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-tool-test-")));
});

afterEach(async () => {
  vi.doUnmock("openclaw/plugin-sdk/media-store");
  vi.doUnmock("../shared/audit.js");
  vi.doUnmock("./node-tool-invoke.js");
  vi.resetModules();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function createTarBuffer(params: {
  entries: string[];
  setup: (sourceDir: string) => Promise<void>;
}): Promise<Buffer> {
  const sourceDir = path.join(tmpRoot, `source-${randomUUID()}`);
  await fs.mkdir(sourceDir, { recursive: true });
  await params.setup(sourceDir);
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ cwd: sourceDir, gzip: true, portable: true }, params.entries)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function importTool(tarBuffer: Buffer) {
  const archivePath = path.join(tmpRoot, `archive-${randomUUID()}.tar.gz`);
  const appendFileTransferAudit = vi.fn(async () => undefined);
  vi.resetModules();
  vi.doMock("openclaw/plugin-sdk/media-store", () => ({
    saveMediaBuffer: vi.fn(async () => {
      await fs.writeFile(archivePath, tarBuffer);
      return { path: archivePath };
    }),
  }));
  vi.doMock("../shared/audit.js", () => ({ appendFileTransferAudit }));
  vi.doMock("./node-tool-invoke.js", () => ({
    readRequiredNodePath: (params: Record<string, unknown>) => ({
      node: String(params.node),
      requestedPath: String(params.path),
    }),
    invokeNodeToolPayload: vi.fn(async () => ({
      nodeId: "node-1",
      nodeDisplayName: "Node One",
      payload: {
        ok: true,
        path: "/tmp/project",
        tarBase64: tarBuffer.toString("base64"),
        tarBytes: tarBuffer.byteLength,
        sha256: crypto.createHash("sha256").update(tarBuffer).digest("hex"),
        fileCount: 1,
      },
      startedAt: Date.now(),
    })),
  }));
  return {
    archivePath,
    appendFileTransferAudit,
    module: await import("./dir-fetch-tool.js"),
  };
}

async function executeDirFetch(module: typeof import("./dir-fetch-tool.js")) {
  return await module.createDirFetchTool().execute("tool-call-1", {
    node: "node-1",
    path: "/tmp/project",
  });
}

describe("dir.fetch archive extraction", () => {
  it("extracts a bounded tar and returns the plugin-side manifest", async () => {
    const tarBuffer = await createTarBuffer({
      entries: ["ok.txt"],
      setup: async (sourceDir) => {
        await fs.writeFile(path.join(sourceDir, "ok.txt"), "ok");
      },
    });
    const { appendFileTransferAudit, module } = await importTool(tarBuffer);

    const result = await executeDirFetch(module);

    expect(result).toMatchObject({
      details: {
        path: "/tmp/project",
        fileCount: 1,
        files: [
          {
            relPath: "ok.txt",
            size: 2,
            sha256: crypto.createHash("sha256").update("ok").digest("hex"),
          },
        ],
      },
    });
    const localPath = (result.details as { files: Array<{ localPath: string }> }).files[0]
      ?.localPath;
    await expect(fs.readFile(localPath!, "utf8")).resolves.toBe("ok");
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "allowed" }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "settles promptly when a Fleet-shaped archive contains a symlink",
    async () => {
      const tarBuffer = await createTarBuffer({
        entries: ["data", "auth"],
        setup: async (sourceDir) => {
          await fs.mkdir(path.join(sourceDir, "data"));
          await fs.mkdir(path.join(sourceDir, "auth"));
          await fs.writeFile(path.join(sourceDir, "data", "state.json"), "{}");
          await fs.writeFile(path.join(sourceDir, "auth", "token"), "secret");
          await fs.symlink("../auth/token", path.join(sourceDir, "data", "token-link"));
        },
      });
      const { appendFileTransferAudit, archivePath, module } = await importTool(tarBuffer);

      const settled = await Promise.race([
        executeDirFetch(module).then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        ),
        new Promise<{ status: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ status: "timeout" }), 2_000);
        }),
      ]);

      expect(settled.status).toBe("rejected");
      expect(settled.status === "rejected" ? String(settled.error) : "").toMatch(
        /dir\.fetch UNSAFE_ARCHIVE:.*link/iu,
      );
      await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ decision: "error", errorCode: "UNSAFE_ARCHIVE" }),
      );
    },
  );

  it.runIf(process.platform !== "win32")("rejects backslash-containing entry names", async () => {
    const tarBuffer = await createTarBuffer({
      entries: ["dir\\escape.txt"],
      setup: async (sourceDir) => {
        await fs.writeFile(path.join(sourceDir, "dir\\escape.txt"), "blocked");
      },
    });
    const { module } = await importTool(tarBuffer);

    await expect(executeDirFetch(module)).rejects.toThrow(/dir\.fetch UNSAFE_ARCHIVE:.*filter/iu);
  });

  it("maps single-entry expansion limits to TREE_TOO_LARGE", async () => {
    const tarBuffer = await createTarBuffer({
      entries: ["large.bin"],
      setup: async (sourceDir) => {
        await fs.writeFile(path.join(sourceDir, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
      },
    });
    const { appendFileTransferAudit, module } = await importTool(tarBuffer);

    await expect(executeDirFetch(module)).rejects.toThrow(
      /dir\.fetch UNCOMPRESSED_TOO_LARGE: archive entry extracted size exceeds limit/iu,
    );
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "error", errorCode: "TREE_TOO_LARGE" }),
    );
  });
});
