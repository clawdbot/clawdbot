import fs from "node:fs/promises";
import path, { basename, dirname, join } from "node:path";
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
