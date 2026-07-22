/** Tests trigger handling for staging inbound media into sandbox workspaces. */
import fs from "node:fs/promises";
import path, { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_MAX_BYTES } from "../media/store.js";
import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "./stage-sandbox-media.test-harness.js";

const sandboxMocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
  assertSandboxPath: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const fsSafeMocks = vi.hoisted(() => {
  class MockFsSafeError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "FsSafeError";
      this.code = code;
    }
  }

  return {
    FsSafeError: MockFsSafeError,
    rootCopyFrom: vi.fn(),
    root: vi.fn(),
    readLocalFileSafely: vi.fn(),
  };
});
const mediaRootMocks = vi.hoisted(() => ({
  resolveChannelRemoteInboundAttachmentRoots: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => sandboxMocks);
vi.mock("../agents/sandbox-paths.js", () => ({
  assertSandboxPath: sandboxMocks.assertSandboxPath,
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});
vi.mock("../infra/fs-safe.js", () => fsSafeMocks);
vi.mock("../media/channel-inbound-roots.js", () => mediaRootMocks);

async function rootCopyFromForTest({
  sourcePath,
  rootDir,
  relativePath,
  maxBytes,
}: {
  sourcePath: string;
  rootDir: string;
  relativePath: string;
  maxBytes?: number;
}) {
  const sourceStat = await fs.stat(sourcePath);
  if (typeof maxBytes === "number" && sourceStat.size > maxBytes) {
    throw new fsSafeMocks.FsSafeError(
      "too-large",
      `file exceeds limit of ${maxBytes} bytes (got ${sourceStat.size})`,
    );
  }

  await fs.mkdir(rootDir, { recursive: true });
  const rootReal = await fs.realpath(rootDir);
  const destPath = path.resolve(rootReal, relativePath);
  const rootPrefix = `${rootReal}${path.sep}`;
  if (destPath !== rootReal && !destPath.startsWith(rootPrefix)) {
    throw new fsSafeMocks.FsSafeError("outside-workspace", "file is outside workspace root");
  }

  const parentDir = dirname(destPath);
  const relativeParent = path.relative(rootReal, parentDir);
  if (relativeParent && !relativeParent.startsWith("..")) {
    let cursor = rootReal;
    for (const segment of relativeParent.split(path.sep)) {
      cursor = path.join(cursor, segment);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) {
          throw new fsSafeMocks.FsSafeError("symlink", "symlink not allowed");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await fs.mkdir(cursor, { recursive: true });
          continue;
        }
        throw error;
      }
    }
  }

  try {
    const destStat = await fs.lstat(destPath);
    if (destStat.isSymbolicLink()) {
      throw new fsSafeMocks.FsSafeError("symlink", "symlink not allowed");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.copyFile(sourcePath, destPath);
}

beforeEach(() => {
  sandboxMocks.ensureSandboxWorkspaceForSession.mockReset();
  sandboxMocks.assertSandboxPath.mockReset().mockResolvedValue({ resolved: "", relative: "" });
  childProcessMocks.spawn.mockClear();
  fsSafeMocks.rootCopyFrom.mockReset().mockImplementation(rootCopyFromForTest);
  fsSafeMocks.root.mockReset().mockImplementation(async (rootDir: string) => ({
    copyIn: async (relativePath: string, sourcePath: string, options?: { maxBytes?: number }) =>
      await rootCopyFromForTest({
        sourcePath,
        rootDir,
        relativePath,
        maxBytes: options?.maxBytes,
      }),
  }));
  mediaRootMocks.resolveChannelRemoteInboundAttachmentRoots
    .mockReset()
    .mockReturnValue(["/Users/demo/Library/Messages/Attachments"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
});

async function setupSandboxWorkspace(home: string): Promise<{
  cfg: ReturnType<typeof createSandboxMediaStageConfig>;
  workspaceDir: string;
  sandboxDir: string;
}> {
  const cfg = createSandboxMediaStageConfig(home);
  const workspaceDir = join(home, "openclaw");
  const sandboxDir = join(home, "sandboxes", "session");
  await fs.mkdir(sandboxDir, { recursive: true });
  sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue({
    workspaceDir: sandboxDir,
    containerWorkdir: "/work",
  });
  return { cfg, workspaceDir, sandboxDir };
}

async function writeInboundMedia(
  home: string,
  fileName: string,
  payload: string | Buffer,
): Promise<string> {
  const inboundDir = join(home, ".openclaw", "media", "inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  const mediaPath = join(inboundDir, fileName);
  await fs.writeFile(mediaPath, payload);
  return mediaPath;
}

describe("stageSandboxMedia", () => {
  it("stages managed inbound media URIs into the sandbox workspace", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);
      const fileName = "report.pdf";
      await writeInboundMedia(home, fileName, "pdf-bytes");
      const mediaUri = `media://inbound/${fileName}`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      ctx.MediaType = "application/pdf";
      sessionCtx.MediaType = "application/pdf";

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      const stagedPath = `media/inbound/${fileName}`;
      expect(result.staged.get(0)).toBe(stagedPath);
      expect(ctx.MediaPath).toBe(stagedPath);
      expect(sessionCtx.MediaPath).toBe(stagedPath);
      expect(ctx.MediaUrl).toBe(stagedPath);
      expect(sessionCtx.MediaUrl).toBe(stagedPath);
      expect(ctx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir: sandboxDir });
      expect(sessionCtx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir: sandboxDir });
      await expect(fs.readFile(join(sandboxDir, stagedPath), "utf8")).resolves.toBe("pdf-bytes");
    });
  });

  it("keeps host-staged inbound images available to native vision", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const cfg = createSandboxMediaStageConfig(home);
      const workspaceDir = join(home, "openclaw");
      sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
      const fileName = "host-photo.png";
      await writeInboundMedia(home, fileName, "host-image-bytes");
      const existingProjectFile = join(workspaceDir, "media", "inbound", fileName);
      await fs.mkdir(dirname(existingProjectFile), { recursive: true });
      await fs.writeFile(existingProjectFile, "project-file");
      const mediaUri = `media://inbound/${fileName}`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      ctx.MediaType = "image/png";
      sessionCtx.MediaType = "image/png";

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      const stagedPath = ctx.MediaPath ?? "";
      const stagedRelativePath = path.relative(workspaceDir, stagedPath);
      expect(stagedRelativePath).toMatch(
        new RegExp(`^media/inbound/openclaw-staged-[0-9a-f-]+/${fileName}$`),
      );
      expect(result.staged.get(0)).toBe(stagedPath);
      expect(sessionCtx.MediaPath).toBe(stagedPath);
      expect(ctx.MediaWorkspaceDir).toBe(dirname(stagedPath));
      expect(sessionCtx.MediaWorkspaceDir).toBeUndefined();
      expect(ctx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir });
      expect(sessionCtx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir });
      await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("host-image-bytes");
      await expect(fs.readFile(existingProjectFile, "utf8")).resolves.toBe("project-file");

      const blockedPath = join(home, "blocked-host.png");
      await fs.writeFile(blockedPath, "blocked");
      const { ctx: blockedCtx, sessionCtx: blockedSessionCtx } =
        createSandboxMediaContexts(blockedPath);
      blockedCtx.MediaWorkspaceDir = workspaceDir;
      blockedSessionCtx.MediaWorkspaceDir = workspaceDir;
      const blockedResult = await stageSandboxMedia({
        ctx: blockedCtx,
        sessionCtx: blockedSessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });
      expect(blockedResult.staged).toEqual(new Map());
      expect(blockedCtx.MediaWorkspaceDir).toBe(workspaceDir);
      expect(blockedSessionCtx.MediaWorkspaceDir).toBe(workspaceDir);

      const partialCtx = {
        media: [
          { path: mediaUri, contentType: "image/png" },
          { path: blockedPath, contentType: "image/png" },
        ],
      };
      const partialSessionCtx = {
        media: [
          { path: mediaUri, contentType: "image/png" },
          { path: blockedPath, contentType: "image/png" },
        ],
      };
      const partialResult = await stageSandboxMedia({
        ctx: partialCtx,
        sessionCtx: partialSessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });
      expect([...partialResult.staged.keys()]).toEqual([0]);
      expect(partialResult.staged.get(0)).toBe(partialCtx.media[0]?.path);
      expect(partialCtx).not.toHaveProperty("MediaWorkspaceDir");
      expect(partialCtx.media[0]).toMatchObject({ workspaceDir });
      expect(partialCtx.media[1]).toMatchObject({ path: blockedPath, contentType: "image/png" });
      expect(partialCtx.media[1]).not.toHaveProperty("workspaceDir");
      expect(partialSessionCtx.media).toEqual(partialCtx.media);
    });
  });

  it("stages allowed media and blocks unsafe paths", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);

      {
        const mediaPath = await writeInboundMedia(home, "photo.jpg", "test");
        const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        const stagedPath = `media/inbound/${basename(mediaPath)}`;
        expect(ctx.MediaPath).toBe(stagedPath);
        expect(sessionCtx.MediaPath).toBe(stagedPath);
        expect(ctx.MediaUrl).toBe(stagedPath);
        expect(sessionCtx.MediaUrl).toBe(stagedPath);
        const stagedStats = await fs.stat(
          join(sandboxDir, "media", "inbound", basename(mediaPath)),
        );
        expect(stagedStats.isFile()).toBe(true);
      }

      {
        const sensitiveFile = join(home, "secrets.txt");
        await fs.writeFile(sensitiveFile, "SENSITIVE DATA");
        const { ctx, sessionCtx } = createSandboxMediaContexts(sensitiveFile);

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        let stagedStatError: NodeJS.ErrnoException | undefined;
        try {
          await fs.stat(join(sandboxDir, "media", "inbound", basename(sensitiveFile)));
        } catch (error) {
          stagedStatError = error as NodeJS.ErrnoException;
        }
        expect(stagedStatError?.code).toBe("ENOENT");
        expect(ctx.MediaPath).toBe(sensitiveFile);
      }

      {
        expect(mediaRootMocks.resolveChannelRemoteInboundAttachmentRoots).not.toHaveBeenCalled();
        childProcessMocks.spawn.mockClear();
        const { ctx, sessionCtx } = createSandboxMediaContexts("/etc/passwd");
        ctx.Provider = "imessage";
        ctx.MediaRemoteHost = "user@gateway-host";
        sessionCtx.Provider = "imessage";
        sessionCtx.MediaRemoteHost = "user@gateway-host";

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        expect(childProcessMocks.spawn).not.toHaveBeenCalled();
        expect(ctx.MediaPath).toBe("/etc/passwd");
      }
    });
  });

  it.each([
    { name: "failed slot before staged slot", allowedIndex: 1, blockedIndex: 0 },
    { name: "staged slot before failed slot", allowedIndex: 0, blockedIndex: 1 },
  ])("updates facts positionally: $name", async ({ allowedIndex, blockedIndex }) => {
    await withSandboxMediaTempHome("openclaw-staging-slots-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);
      const allowedPath = await writeInboundMedia(home, "allowed.jpg", "allowed");
      const blockedPath = join(home, "blocked.jpg");
      await fs.writeFile(blockedPath, "blocked");
      const allowedUrl = "https://cdn.example/allowed.jpg";
      const media = [allowedPath, blockedPath].map((pathValue, index) => ({
        path: pathValue,
        url: index === 0 ? allowedUrl : undefined,
        contentType: "image/jpeg",
      }));
      if (allowedIndex === 1) {
        media.reverse();
      }
      const ctx = { media };
      const sessionCtx = {
        media: media.map((fact) => ({
          path: fact.path,
          url: fact.url,
          contentType: fact.contentType,
        })),
      };

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      const stagedPath = "media/inbound/allowed.jpg";
      expect(result.staged).toEqual(new Map([[allowedIndex, stagedPath]]));
      expect(ctx.media[allowedIndex]).toMatchObject({ path: stagedPath, workspaceDir: sandboxDir });
      expect(ctx.media[allowedIndex]?.url).toBe(allowedUrl);
      expect(ctx).toHaveProperty(`MediaUrls.${allowedIndex}`, allowedUrl);
      expect(ctx.media[blockedIndex]).toMatchObject({ path: blockedPath });
      expect(ctx.media[blockedIndex]).not.toHaveProperty("workspaceDir");
      expect(sessionCtx.media).toEqual(ctx.media);
    });
  });

  it.each([
    {
      name: "media URI path and physical-path URL",
      source: "media-uri",
      url: "physical-path",
      rewritesUrl: true,
    },
    {
      name: "physical path and media-URI URL",
      source: "physical-path",
      url: "media-uri",
      rewritesUrl: true,
    },
    {
      name: "physical path and file-URL URL",
      source: "physical-path",
      url: "file-url",
      rewritesUrl: true,
    },
    {
      name: "physical path and distinct remote URL",
      source: "physical-path",
      url: "remote-url",
      rewritesUrl: false,
    },
  ] as const)(
    "rewrites resolved local URL aliases: $name",
    async ({ source, url, rewritesUrl }) => {
      await withSandboxMediaTempHome("openclaw-staging-url-alias-", async (home) => {
        const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);
        const fileName = "alias.jpg";
        const mediaPath = await writeInboundMedia(home, fileName, "alias-bytes");
        const mediaUri = `media://inbound/${fileName}`;
        const sourcePath = source === "media-uri" ? mediaUri : mediaPath;
        const mediaUrl =
          url === "media-uri"
            ? mediaUri
            : url === "file-url"
              ? pathToFileURL(mediaPath).href
              : url === "remote-url"
                ? "https://cdn.example/alias.jpg"
                : mediaPath;
        const ctx = {
          media: [{ path: sourcePath, url: mediaUrl, contentType: "image/jpeg" }],
        };
        const sessionCtx = {
          media: [{ path: sourcePath, url: mediaUrl, contentType: "image/jpeg" }],
        };

        const result = await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        const stagedPath = `media/inbound/${fileName}`;
        const expectedUrl = rewritesUrl ? stagedPath : mediaUrl;
        expect(result.staged).toEqual(new Map([[0, stagedPath]]));
        expect(ctx.media[0]).toMatchObject({
          path: stagedPath,
          url: expectedUrl,
          workspaceDir: sandboxDir,
        });
        expect(ctx).toHaveProperty("MediaUrl", expectedUrl);
        expect(sessionCtx.media).toEqual(ctx.media);
      });
    },
  );

  it("blocks destination symlink escapes when staging into sandbox workspace", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);

      const mediaPath = await writeInboundMedia(home, "payload.txt", "PAYLOAD");

      const outsideDir = join(home, "outside");
      const outsideInboundDir = join(outsideDir, "inbound");
      await fs.mkdir(outsideInboundDir, { recursive: true });
      const victimPath = join(outsideDir, "victim.txt");
      await fs.writeFile(victimPath, "ORIGINAL");

      await fs.mkdir(sandboxDir, { recursive: true });
      await fs.symlink(outsideDir, join(sandboxDir, "media"));
      await fs.symlink(victimPath, join(outsideInboundDir, basename(mediaPath)));

      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      await expect(fs.readFile(victimPath, "utf8")).resolves.toBe("ORIGINAL");
      expect(ctx.MediaPath).toBe(mediaPath);
      expect(sessionCtx.MediaPath).toBe(mediaPath);
    });
  });

  it("skips oversized media staging and keeps original media paths", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = await setupSandboxWorkspace(home);

      const mediaPath = await writeInboundMedia(
        home,
        "oversized.bin",
        Buffer.alloc(MEDIA_MAX_BYTES + 1, 0x41),
      );

      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      let stagedStatError: NodeJS.ErrnoException | undefined;
      try {
        await fs.stat(join(sandboxDir, "media", "inbound", basename(mediaPath)));
      } catch (error) {
        stagedStatError = error as NodeJS.ErrnoException;
      }
      expect(stagedStatError?.code).toBe("ENOENT");
      expect(ctx.MediaPath).toBe(mediaPath);
      expect(sessionCtx.MediaPath).toBe(mediaPath);
    });
  });
});
