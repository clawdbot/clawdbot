// Verifies ClawHub archive integrity, limits, cleanup, and authentication boundaries.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  type ClawHubDownloadResult,
  downloadClawHubGitHubSkillArchive,
  downloadClawHubPackageArchive,
  downloadClawHubSkillArchive,
  downloadClawHubSkillArchiveUrl,
  normalizeClawHubSha256Integrity,
  normalizeClawHubSha256Hex,
} from "./clawhub-artifacts.js";
import * as privateTempWorkspace from "./private-temp-workspace.js";

const tempDirs = createTrackedTempDirs();

type FsSafeTempWorkspace = Awaited<ReturnType<typeof privateTempWorkspace.tempWorkspace>>;
type TempWorkspace = Omit<FsSafeTempWorkspace, "cleanup"> & {
  cleanup: () => ReturnType<FsSafeTempWorkspace["cleanup"]>;
};

async function observeTempWorkspace(params: { cleanupFailure?: Error } = {}) {
  const root = await tempDirs.make("openclaw-clawhub-archive-");
  const createWorkspace = privateTempWorkspace.tempWorkspace;
  let workspace: TempWorkspace | undefined;
  vi.spyOn(privateTempWorkspace, "tempWorkspace").mockImplementation(async (options) => {
    const ownedWorkspace = await createWorkspace({ ...options, rootDir: root });
    workspace = {
      ...ownedWorkspace,
      cleanup: vi.fn(async () => {
        const result = await ownedWorkspace.cleanup();
        if (params.cleanupFailure) {
          throw params.cleanupFailure;
        }
        return result;
      }),
    };
    return workspace;
  });

  return {
    root,
    workspace(): TempWorkspace {
      if (!workspace) {
        throw new Error("archive acquisition did not create a temporary workspace");
      }
      return workspace;
    },
  };
}

function createArchiveResponse(bytes: Uint8Array, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", responseHeaders.get("content-type") ?? "application/zip");
  responseHeaders.set(
    "X-ClawHub-Artifact-Sha256",
    createHash("sha256").update(bytes).digest("hex"),
  );
  responseHeaders.set(
    "X-ClawHub-Npm-Integrity",
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  );
  responseHeaders.set("X-ClawHub-Npm-Shasum", createHash("sha1").update(bytes).digest("hex"));
  responseHeaders.set("X-ClawHub-Npm-Tarball-Name", "registry-selected.tgz");
  responseHeaders.set("X-ClawHub-ClawPack-Spec-Version", "3");
  return new Response(new Uint8Array(bytes), { status: 200, headers: responseHeaders });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let statError: unknown;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  if (statError === undefined) {
    throw new Error(`Expected ${targetPath} to be missing`);
  }
  expect((statError as { code?: unknown }).code).toBe("ENOENT");
}

function createStalledBodyResponse(params: {
  headers: HeadersInit;
  firstChunk: Uint8Array;
  status?: number;
  statusText?: string;
}): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(params.firstChunk);
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: params.status ?? 200,
      statusText: params.statusText,
      headers: params.headers,
    }),
    cancel,
  };
}

function createOversizedArchiveResponse(
  params: {
    headers?: HeadersInit;
  } = {},
): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancel();
    },
  });
  const headers = new Headers(params.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/zip");
  headers.set("content-length", String(256 * 1024 * 1024 + 512 * 1024));
  return {
    response: new Response(body, {
      status: 200,
      headers,
    }),
    cancel,
  };
}

const archiveDownloadCases: Array<{
  name: string;
  headers?: HeadersInit;
  download: (response: Response) => Promise<ClawHubDownloadResult>;
  expectedResource: string;
  expectedFileName: string;
  expectedArtifact?: "clawpack";
}> = [
  {
    name: "package archive",
    download: (response) =>
      downloadClawHubPackageArchive({
        name: "@hyf/zai-external-alpha",
        version: "0.0.1",
        token: "test-token",
        fetchImpl: async () => response,
      }),
    expectedResource: "package archive download for @hyf/zai-external-alpha",
    expectedFileName: "zai-external-alpha.zip",
  },
  {
    name: "ClawPack artifact",
    headers: { "content-type": "application/octet-stream" },
    download: (response) =>
      downloadClawHubPackageArchive({
        name: "demo",
        version: "1.2.3",
        artifact: "clawpack",
        token: "test-token",
        fetchImpl: async () => response,
      }),
    expectedResource: "ClawPack download for demo@1.2.3",
    expectedFileName: "registry-selected.tgz",
    expectedArtifact: "clawpack",
  },
  {
    name: "skill archive",
    download: (response) =>
      downloadClawHubSkillArchive({
        slug: "agentreceipt",
        version: "1.0.0",
        token: "test-token",
        fetchImpl: async () => response,
      }),
    expectedResource: "skill archive download for agentreceipt",
    expectedFileName: "agentreceipt.zip",
  },
  {
    name: "resolver URL archive",
    download: (response) =>
      downloadClawHubSkillArchiveUrl({
        baseUrl: "https://clawhub.ai",
        url: "https://downloads.example.com/skill.zip",
        fetchImpl: async () => response,
      }),
    expectedResource: "skill archive download at /skill.zip",
    expectedFileName: "skill.zip",
  },
  {
    name: "GitHub source archive",
    download: (response) =>
      downloadClawHubGitHubSkillArchive({
        repo: "owner/repo",
        commit: "abc123",
        fetchImpl: async () => response,
      }),
    expectedResource: "GitHub source archive for owner/repo@abc123",
    expectedFileName: "abc123.zip",
  },
];

describe("clawhub artifacts", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CLAWHUB_TOKEN;
    await tempDirs.cleanup();
  });

  it("normalizes raw ClawHub SHA-256 hashes into integrity strings", () => {
    const hex = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const integrity = "sha256-A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=";
    const unpaddedIntegrity = "sha256-A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E";
    expect(normalizeClawHubSha256Integrity(hex)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(`sha256:${hex}`)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(integrity)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(unpaddedIntegrity)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(`sha256=${hex}`)).toBeNull();
    expect(normalizeClawHubSha256Integrity("sha256-a=")).toBeNull();
    expect(normalizeClawHubSha256Integrity("not-a-hash")).toBeNull();
  });

  it("normalizes ClawHub SHA-256 hex values", () => {
    expect(normalizeClawHubSha256Hex("AA".repeat(32))).toBe("aa".repeat(32));
    expect(normalizeClawHubSha256Hex("not-a-hash")).toBeNull();
  });

  it("downloads package archives to sanitized temp paths and cleans them up", async () => {
    const archive = await downloadClawHubPackageArchive({
      name: "@hyf/zai-external-alpha",
      version: "0.0.1",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        }),
    });

    try {
      expect(path.basename(archive.archivePath)).toBe("zai-external-alpha.zip");
      expect(archive.archivePath.includes("@hyf")).toBe(false);
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });

  it("downloads ClawPack package artifacts from the version route and verifies response headers", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const sha256Hex = createHash("sha256").update(bytes).digest("hex");
    const sha1Hex = createHash("sha1").update(bytes).digest("hex");
    let requestedUrl = "";
    const archive = await downloadClawHubPackageArchive({
      name: "demo",
      version: "1.2.3",
      artifact: "clawpack",
      fetchImpl: async (input) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "X-ClawHub-Artifact-Sha256": sha256Hex,
          },
        });
      },
    });

    try {
      expect(new URL(requestedUrl).pathname).toBe(
        "/api/v1/packages/demo/versions/1.2.3/artifact/download",
      );
      expect(path.basename(archive.archivePath)).toBe("demo-1.2.3.tgz");
      expect(archive.artifact).toBe("clawpack");
      expect(archive.sha256Hex).toBe(sha256Hex);
      expect(archive.clawpackHeaderSha256).toBe(sha256Hex);
      expect(archive.npmIntegrity).toMatch(/^sha512-/);
      expect(archive.npmShasum).toBe(sha1Hex);
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(bytes));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });

  it("rejects ClawPack package artifacts when the declared digest does not match the bytes", async () => {
    await expect(
      downloadClawHubPackageArchive({
        name: "demo",
        version: "1.2.3",
        artifact: "clawpack",
        fetchImpl: async () =>
          new Response(new Uint8Array([7, 8, 9]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "X-ClawHub-Artifact-Sha256": "0".repeat(64),
            },
          }),
      }),
    ).rejects.toThrow(/declared sha256/);
  });

  it.each(archiveDownloadCases)(
    "rejects and cancels oversized $name downloads",
    async ({ headers, download, expectedResource }) => {
      const oversized = createOversizedArchiveResponse({ headers });

      await expect(download(oversized.response)).rejects.toThrow(
        `ClawHub ${expectedResource} exceeded 268435456 bytes (268959744 bytes declared)`,
      );
      expect(oversized.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each(archiveDownloadCases)(
    "removes the owned workspace when writing a $name partially fails",
    async ({ headers, download }) => {
      const observed = await observeTempWorkspace();
      const unrelatedFile = path.join(observed.root, "preexisting.txt");
      await fs.writeFile(unrelatedFile, "preserved");

      const writeError = Object.assign(new Error("disk full after partial archive write"), {
        code: "ENOSPC",
      });
      const writeFile = fs.writeFile;
      vi.spyOn(fs, "writeFile").mockImplementation(async (file) => {
        await writeFile(file, new Uint8Array([1]));
        throw writeError;
      });

      const bytes = new Uint8Array([7, 8, 9]);

      await expect(download(createArchiveResponse(bytes, headers))).rejects.toBe(writeError);
      const workspace = observed.workspace();
      expect(workspace.cleanup).toHaveBeenCalledOnce();
      await expectPathMissing(workspace.dir);
      await expect(fs.readFile(unrelatedFile, "utf8")).resolves.toBe("preserved");
      await expect(fs.readdir(observed.root)).resolves.toEqual(["preexisting.txt"]);
    },
  );

  it.each(archiveDownloadCases)(
    "preserves $name bytes, integrity, metadata, and caller-owned cleanup",
    async ({ headers, download, expectedFileName, expectedArtifact }) => {
      const observed = await observeTempWorkspace();
      const bytes = new Uint8Array([7, 8, 9]);
      const sha256Digest = createHash("sha256").update(bytes).digest("hex");
      const archive = await download(createArchiveResponse(bytes, headers));
      const workspace = observed.workspace();

      expect(path.basename(archive.archivePath)).toBe(expectedFileName);
      expect(archive.artifact).toBe(expectedArtifact ?? "archive");
      expect(archive.sha256Hex).toBe(sha256Digest);
      expect(archive.integrity).toBe(
        `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
      );
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(bytes));
      expect(workspace.cleanup).not.toHaveBeenCalled();

      if (expectedArtifact === "clawpack") {
        expect(archive.clawpackHeaderSha256).toBe(sha256Digest);
        expect(archive.clawpackHeaderSpecVersion).toBe(3);
        expect(archive.npmIntegrity).toBe(
          `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        );
        expect(archive.npmShasum).toBe(createHash("sha1").update(bytes).digest("hex"));
        expect(archive.npmTarballName).toBe("registry-selected.tgz");
      }

      await archive.cleanup();
      expect(workspace.cleanup).toHaveBeenCalledOnce();
      await expectPathMissing(workspace.dir);
    },
  );

  it("does not delete a replacement workspace after an archive write failure", async () => {
    const observed = await observeTempWorkspace();
    const writeError = Object.assign(new Error("disk full after workspace replacement"), {
      code: "ENOSPC",
    });
    const writeFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file) => {
      await writeFile(file, new Uint8Array([1]));
      const workspace = observed.workspace();
      await fs.rename(workspace.dir, `${workspace.dir}-original`);
      await fs.mkdir(workspace.dir);
      await writeFile(path.join(workspace.dir, "replacement-marker"), "preserved");
      throw writeError;
    });

    await expect(
      downloadClawHubSkillArchive({
        slug: "replacement-skill",
        token: "test-token",
        fetchImpl: async () => createArchiveResponse(new Uint8Array([4, 5, 6])),
      }),
    ).rejects.toBe(writeError);

    const workspace = observed.workspace();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
    await expect(vi.mocked(workspace.cleanup).mock.results[0]?.value).resolves.toBe(
      "identity-mismatch",
    );
    await expect(fs.readFile(path.join(workspace.dir, "replacement-marker"), "utf8")).resolves.toBe(
      "preserved",
    );
    await expect(
      fs.readFile(path.join(`${workspace.dir}-original`, "replacement-skill.zip")),
    ).resolves.toEqual(Buffer.from([1]));
  });

  it.each(["cleanup", "cleanup logging"])(
    "keeps the original archive write failure when %s fails",
    async (failureStage) => {
      const cleanupError = new Error("temporary workspace cleanup failed");
      if (failureStage === "cleanup logging") {
        cleanupError.toString = () => {
          throw new Error("temporary workspace cleanup logger failed");
        };
      }
      const observed = await observeTempWorkspace({ cleanupFailure: cleanupError });
      const writeError = Object.assign(new Error("disk full after partial archive write"), {
        code: "ENOSPC",
      });
      const writeFile = fs.writeFile;
      vi.spyOn(fs, "writeFile").mockImplementation(async (file) => {
        await writeFile(file, new Uint8Array([1]));
        throw writeError;
      });

      await expect(
        downloadClawHubSkillArchive({
          slug: "cleanup-failure-skill",
          token: "test-token",
          fetchImpl: async () => createArchiveResponse(new Uint8Array([4, 5, 6])),
        }),
      ).rejects.toBe(writeError);
      expect(observed.workspace().cleanup).toHaveBeenCalledOnce();
      await expectPathMissing(observed.workspace().dir);
    },
  );

  it("uses decoded stream bytes instead of encoded content length", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const archive = await downloadClawHubPackageArchive({
      name: "encoded-package",
      version: "1.0.0",
      fetchImpl: async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-encoding": "gzip",
            "content-length": String(256 * 1024 * 1024 + 1),
            "content-type": "application/zip",
          },
        }),
    });
    try {
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(bytes));
    } finally {
      await archive.cleanup();
    }
  });

  it("times out and cancels stalled skill archive body reads", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new Uint8Array([4]),
      headers: { "content-type": "application/zip" },
    });

    await expect(
      downloadClawHubSkillArchive({
        slug: "agentreceipt",
        version: "1.0.0",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(/skill archive download for agentreceipt body stalled after 5ms/i);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("times out and cancels stalled package archive body reads", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new Uint8Array([1]),
      headers: { "content-type": "application/zip" },
    });

    await expect(
      downloadClawHubPackageArchive({
        name: "@hyf/zai-external-alpha",
        version: "0.0.1",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(
      /package archive download for @hyf\/zai-external-alpha body stalled after 5ms/i,
    );
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("times out and cancels stalled ClawPack artifact body reads", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new Uint8Array([7]),
      headers: { "content-type": "application/octet-stream" },
    });

    await expect(
      downloadClawHubPackageArchive({
        name: "demo",
        version: "1.2.3",
        artifact: "clawpack",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(/ClawPack download for demo@1.2.3 body stalled after 5ms/i);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("downloads skill archives to sanitized temp paths and cleans them up", async () => {
    const archive = await downloadClawHubSkillArchive({
      slug: "agentreceipt",
      version: "1.0.0",
      fetchImpl: async () =>
        new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        }),
    });

    try {
      expect(path.basename(archive.archivePath)).toBe("agentreceipt.zip");
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from([4, 5, 6]));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });

  it("sends owner-qualified skill archive downloads as slug plus ownerHandle", async () => {
    let requestedUrl = "";
    const archive = await downloadClawHubSkillArchive({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.0.0",
      fetchImpl: async (input) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        return new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      },
    });

    try {
      const url = new URL(requestedUrl);
      expect(url.pathname).toBe("/api/v1/download");
      expect(url.searchParams.get("slug")).toBe("weather");
      expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
      expect(url.searchParams.get("version")).toBe("1.0.0");
    } finally {
      await archive.cleanup();
    }
  });

  it("does not send ambient ClawHub auth tokens to off-registry resolver archive URLs", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;

    const archive = await downloadClawHubSkillArchiveUrl({
      baseUrl: "https://clawhub.ai",
      url: "https://codeload.github.com/NVIDIA/skills/zip/abcdef",
      fetchImpl: async (input, init) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        requestedInit = init;
        return new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      },
    });

    try {
      expect(requestedUrl).toBe("https://codeload.github.com/NVIDIA/skills/zip/abcdef");
      expect(new Headers(requestedInit?.headers).get("Authorization")).toBeNull();
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from([7, 8, 9]));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });
});
