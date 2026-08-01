import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_PROXY_UPLOAD_ENVELOPE,
  type BrowserProxyUploadV1,
} from "./browser-proxy-envelope.js";
import {
  discardStagedBrowserProxyUpload,
  ensureBrowserProxyUploadCleanup,
  prepareBrowserProxyUploadRequest,
  stageBrowserProxyUploadRequest,
} from "./browser-proxy-upload.js";
import { resolveExistingUploadPaths } from "./browser/paths.js";

const tempRoots: string[] = [];

async function createTempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("browser proxy upload transport", () => {
  it("reads Gateway-owned files into a versioned envelope and omits node-facing paths", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-gateway-");
    const uploadDir = path.join(root, "uploads");
    const inboundMediaDir = path.join(root, "media", "inbound");
    await fs.mkdir(uploadDir, { recursive: true });
    const sourcePath = path.join(uploadDir, "report.txt");
    await fs.writeFile(sourcePath, "gateway bytes", "utf8");

    const prepared = await prepareBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { paths: [sourcePath], ref: "e12" },
      uploadDir,
      inboundMediaDir,
    });

    expect(prepared.body).toEqual({ ref: "e12" });
    expect(prepared.upload).toEqual({
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [
        {
          name: "report.txt",
          contentBase64: Buffer.from("gateway bytes").toString("base64"),
        },
      ],
    });
  });

  it("preserves zero-byte files", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-empty-");
    const uploadDir = path.join(root, "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const sourcePath = path.join(uploadDir, "empty.txt");
    await fs.writeFile(sourcePath, "");

    const prepared = await prepareBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { paths: [sourcePath] },
      uploadDir,
      inboundMediaDir: path.join(root, "inbound"),
    });

    expect(prepared.upload?.files).toEqual([{ name: "empty.txt", contentBase64: "" }]);
  });

  it("transfers Gateway inbound media bytes instead of resolving the URI on the node", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-inbound-");
    const uploadDir = path.join(root, "uploads");
    const inboundMediaDir = path.join(root, "media", "inbound");
    await fs.mkdir(inboundMediaDir, { recursive: true });
    await fs.writeFile(path.join(inboundMediaDir, "report.txt"), "gateway inbound bytes", "utf8");

    const prepared = await prepareBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { paths: ["media://inbound/report.txt"] },
      uploadDir,
      inboundMediaDir,
    });

    expect(prepared.body).toEqual({});
    expect(prepared.upload?.files).toEqual([
      {
        name: "report.txt",
        contentBase64: Buffer.from("gateway inbound bytes").toString("base64"),
      },
    ]);
  });

  it("carries a prepared Gateway file through real node staging and route validation", async () => {
    const gatewayRoot = await createTempRoot("openclaw-browser-proxy-gateway-root-");
    const nodeRoot = await createTempRoot("openclaw-browser-proxy-node-root-");
    const gatewayUploadDir = path.join(gatewayRoot, "uploads");
    const nodeUploadDir = path.join(nodeRoot, "uploads");
    await fs.mkdir(gatewayUploadDir, { recursive: true });
    const sourcePath = path.join(gatewayUploadDir, "report.txt");
    await fs.writeFile(sourcePath, "cross-host bytes", "utf8");

    const prepared = await prepareBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { paths: [sourcePath], ref: "e12" },
      uploadDir: gatewayUploadDir,
      inboundMediaDir: path.join(gatewayRoot, "inbound"),
    });
    if (!prepared.upload) {
      throw new Error("expected browser proxy upload envelope");
    }
    const staged = await stageBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: prepared.body,
      upload: prepared.upload,
      uploadDir: nodeUploadDir,
    });
    const stagedPaths = (staged.body as { paths: string[] }).paths;

    expect(stagedPaths).toHaveLength(1);
    expect(stagedPaths[0]?.startsWith(`${nodeUploadDir}${path.sep}`)).toBe(true);
    await expect(fs.readFile(stagedPaths[0] ?? "", "utf8")).resolves.toBe("cross-host bytes");
    await expect(
      resolveExistingUploadPaths({
        requestedPaths: stagedPaths,
        uploadDir: nodeUploadDir,
        inboundMediaDir: path.join(nodeRoot, "inbound"),
      }),
    ).resolves.toEqual({ ok: true, paths: stagedPaths });

    await discardStagedBrowserProxyUpload(staged);
  });

  it("round-trips the exact 16 MiB aggregate file limit", async () => {
    const gatewayRoot = await createTempRoot("openclaw-browser-proxy-limit-gateway-");
    const nodeRoot = await createTempRoot("openclaw-browser-proxy-limit-node-");
    const gatewayUploadDir = path.join(gatewayRoot, "uploads");
    const nodeUploadDir = path.join(nodeRoot, "uploads");
    await fs.mkdir(gatewayUploadDir, { recursive: true });
    const firstPath = path.join(gatewayUploadDir, "first.bin");
    const secondPath = path.join(gatewayUploadDir, "second.bin");
    await fs.writeFile(firstPath, Buffer.alloc(10 * 1024 * 1024, 0x61));
    await fs.writeFile(secondPath, Buffer.alloc(6 * 1024 * 1024, 0x62));

    const prepared = await prepareBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { paths: [firstPath, secondPath] },
      uploadDir: gatewayUploadDir,
      inboundMediaDir: path.join(gatewayRoot, "inbound"),
    });
    if (!prepared.upload) {
      throw new Error("expected browser proxy upload envelope");
    }
    const staged = await stageBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: prepared.body,
      upload: prepared.upload,
      uploadDir: nodeUploadDir,
    });
    const stagedPaths = (staged.body as { paths: string[] }).paths;

    await expect(fs.stat(stagedPaths[0] ?? "")).resolves.toMatchObject({
      size: 10 * 1024 * 1024,
    });
    await expect(fs.stat(stagedPaths[1] ?? "")).resolves.toMatchObject({
      size: 6 * 1024 * 1024,
    });
    await discardStagedBrowserProxyUpload(staged);
  });

  it("stages files under the node upload root with route-valid paths", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-node-");
    const uploadDir = path.join(root, "uploads");
    const upload: BrowserProxyUploadV1 = {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [
        { name: "report.txt", contentBase64: Buffer.from("node copy").toString("base64") },
        { name: "report.txt", contentBase64: Buffer.from("second copy").toString("base64") },
      ],
    };

    const staged = await stageBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { ref: "e12" },
      upload,
      uploadDir,
    });
    const stagedPaths = (staged.body as { paths: string[] }).paths;

    expect(stagedPaths).toHaveLength(2);
    expect(stagedPaths.map((filePath) => path.basename(filePath))).toEqual([
      "report.txt",
      "report.txt",
    ]);
    await expect(fs.readFile(stagedPaths[0] ?? "", "utf8")).resolves.toBe("node copy");
    await expect(fs.readFile(stagedPaths[1] ?? "", "utf8")).resolves.toBe("second copy");
    await expect(
      resolveExistingUploadPaths({
        requestedPaths: stagedPaths,
        uploadDir,
        inboundMediaDir: path.join(root, "inbound"),
      }),
    ).resolves.toEqual({ ok: true, paths: stagedPaths });

    await discardStagedBrowserProxyUpload(staged);
    await expect(fs.stat(staged.directory ?? "")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects ambiguous request bodies and invalid encodings before dispatch", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-invalid-");
    const upload: BrowserProxyUploadV1 = {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [{ name: "report.txt", contentBase64: "not-base64" }],
    };

    await expect(
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { paths: ["/gateway/report.txt"] },
        upload,
        uploadDir: path.join(root, "uploads"),
      }),
    ).rejects.toThrow("browser proxy upload body must omit paths");

    await expect(
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: {},
        upload,
        uploadDir: path.join(root, "uploads"),
      }),
    ).rejects.toThrow("invalid browser proxy upload encoding");
  });

  it("rejects malformed Gateway path arrays instead of forwarding them to the node", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-malformed-");
    const uploadDir = path.join(root, "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const sourcePath = path.join(uploadDir, "report.txt");
    await fs.writeFile(sourcePath, "gateway bytes", "utf8");

    await expect(
      prepareBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { paths: [sourcePath, 42] },
        uploadDir,
        inboundMediaDir: path.join(root, "inbound"),
      }),
    ).rejects.toThrow("browser proxy upload paths must contain only strings");
  });

  it("uses portable names for Windows-reserved aliases", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-portable-");
    const staged = await stageBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: {},
      upload: {
        envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
        files: [{ name: "COM¹.txt", contentBase64: "aGVsbG8=" }],
      },
      uploadDir: path.join(root, "uploads"),
    });

    expect(path.basename((staged.body as { paths: string[] }).paths[0] ?? "")).toBe("_COM¹.txt");
    await discardStagedBrowserProxyUpload(staged);
  });

  it("enforces retained byte and directory limits across concurrent requests", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-limits-");
    const uploadDir = path.join(root, "uploads");
    const upload: BrowserProxyUploadV1 = {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [{ name: "report.txt", contentBase64: Buffer.from("data").toString("base64") }],
    };

    const results = await Promise.allSettled([
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: {},
        upload,
        uploadDir,
        maxRetainedBytes: 1024,
        maxRetainedDirectories: 1,
      }),
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: {},
        upload,
        uploadDir,
        maxRetainedBytes: 1024,
        maxRetainedDirectories: 1,
      }),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: "RESOURCE_EXHAUSTED: browser proxy upload staging limit reached",
      }),
    });
    const fulfilled = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof stageBrowserProxyUploadRequest>>
      > => result.status === "fulfilled",
    );
    if (fulfilled) {
      await discardStagedBrowserProxyUpload(fulfilled.value);
    }
  });

  it("rejects staging when retained bytes alone exceed the quota", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-byte-limit-");
    const uploadDir = path.join(root, "uploads");
    const upload: BrowserProxyUploadV1 = {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [{ name: "report.txt", contentBase64: Buffer.from("data").toString("base64") }],
    };
    const first = await stageBrowserProxyUploadRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: {},
      upload,
      uploadDir,
      maxRetainedBytes: 40,
      maxRetainedDirectories: 10,
    });

    await expect(
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: {},
        upload,
        uploadDir,
        maxRetainedBytes: 40,
        maxRetainedDirectories: 10,
      }),
    ).rejects.toThrow("browser proxy upload staging limit reached");
    await discardStagedBrowserProxyUpload(first);
  });

  it("counts the ownership marker against retained-byte admission", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-marker-limit-");
    await expect(
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/hooks/file-chooser",
        body: {},
        upload: {
          envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
          files: [{ name: "report.txt", contentBase64: Buffer.from("data").toString("base64") }],
        },
        uploadDir: path.join(root, "uploads"),
        maxRetainedBytes: 4,
        maxRetainedDirectories: 10,
      }),
    ).rejects.toThrow("browser proxy upload staging limit reached");
  });

  it("removes expired staged directories during startup recovery", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-recovery-");
    const uploadDir = path.join(root, "uploads");
    const staleDirectory = path.join(uploadDir, ".proxy-uploads", "upload-stale");
    await fs.mkdir(staleDirectory, { recursive: true });
    await fs.writeFile(
      path.join(staleDirectory, ".openclaw-browser-proxy-upload-v1"),
      "openclaw-browser-proxy-upload-v1\n",
      "utf8",
    );
    await fs.writeFile(path.join(staleDirectory, "report.txt"), "stale", "utf8");
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(staleDirectory, staleTime, staleTime);

    await ensureBrowserProxyUploadCleanup({
      uploadDir,
      retentionMs: 1,
      nowMs: Date.now(),
    });

    await expect(fs.stat(staleDirectory)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("evicts the oldest retained directory during restart recovery when over quota", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-recovery-quota-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const oldestDirectory = path.join(stagingRoot, "upload-oldest");
    const newestDirectory = path.join(stagingRoot, "upload-newest");
    for (const [directory, contents] of [
      [oldestDirectory, "old"],
      [newestDirectory, "new"],
    ] as const) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, ".openclaw-browser-proxy-upload-v1"),
        "openclaw-browser-proxy-upload-v1\n",
        "utf8",
      );
      await fs.writeFile(path.join(directory, "report.txt"), contents, "utf8");
    }
    const now = Date.now();
    await fs.utimes(oldestDirectory, new Date(now - 2_000), new Date(now - 2_000));
    await fs.utimes(newestDirectory, new Date(now - 1_000), new Date(now - 1_000));

    await ensureBrowserProxyUploadCleanup({
      uploadDir,
      nowMs: now,
      maxRetainedBytes: 50,
      maxRetainedDirectories: 10,
    });

    await expect(fs.stat(oldestDirectory)).rejects.toHaveProperty("code", "ENOENT");
    await expect(fs.readFile(path.join(newestDirectory, "report.txt"), "utf8")).resolves.toBe(
      "new",
    );
  });

  it("does not recover unmarked directories from the private staging root", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-recovery-unmarked-");
    const uploadDir = path.join(root, "uploads");
    const unrelatedDirectory = path.join(uploadDir, ".proxy-uploads", "upload-archive");
    await fs.mkdir(unrelatedDirectory, { recursive: true });
    await fs.writeFile(path.join(unrelatedDirectory, "report.txt"), "keep", "utf8");
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(unrelatedDirectory, staleTime, staleTime);

    await ensureBrowserProxyUploadCleanup({
      uploadDir,
      retentionMs: 1,
      nowMs: Date.now(),
    });

    await expect(fs.readFile(path.join(unrelatedDirectory, "report.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("leaves unrelated proxy requests unchanged", async () => {
    const body = { paths: ["/tmp/openclaw/uploads/report.txt"] };
    await expect(
      prepareBrowserProxyUploadRequest({
        method: "POST",
        path: "/act",
        body,
      }),
    ).resolves.toEqual({ body });
    await expect(
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/act",
        body,
      }),
    ).resolves.toEqual({ body });
  });
});
