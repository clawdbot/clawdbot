/** Tests sandbox media staging for SCP remote-path inputs. */
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slugifySessionKey } from "../agents/sandbox/shared.js";
import { CONFIG_DIR } from "../utils.js";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "./stage-sandbox-media.test-harness.js";

const sandboxMocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
}));
const processExecMocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
}));
const mediaRootMocks = vi.hoisted(() => ({
  resolveChannelRemoteInboundAttachmentRoots: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => sandboxMocks);
vi.mock("../media/channel-inbound-roots.js", () => mediaRootMocks);
vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: processExecMocks.runCommandWithTimeout,
  };
});

import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";

afterEach(() => {
  vi.restoreAllMocks();
  processExecMocks.runCommandWithTimeout.mockReset();
  mediaRootMocks.resolveChannelRemoteInboundAttachmentRoots.mockReset();
});

function createRemoteStageParams(home: string): {
  cfg: ReturnType<typeof createSandboxMediaStageConfig>;
  workspaceDir: string;
  sessionKey: string;
  remoteCacheDir: string;
} {
  const sessionKey = "agent:main:main";
  vi.mocked(sandboxMocks.ensureSandboxWorkspaceForSession).mockResolvedValue(null);
  mediaRootMocks.resolveChannelRemoteInboundAttachmentRoots.mockReturnValue([
    "/Users/demo/Library/Messages/Attachments",
  ]);
  return {
    cfg: createSandboxMediaStageConfig(home),
    workspaceDir: join(home, "openclaw"),
    sessionKey,
    remoteCacheDir: join(home, ".openclaw", "media", "remote-cache", slugifySessionKey(sessionKey)),
  };
}

function createRemoteContexts(remotePath: string) {
  const { ctx, sessionCtx } = createSandboxMediaContexts(remotePath);
  ctx.Provider = "imessage";
  ctx.MediaRemoteHost = "user@gateway-host";
  sessionCtx.Provider = "imessage";
  sessionCtx.MediaRemoteHost = "user@gateway-host";
  return { ctx, sessionCtx };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let statError: unknown;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  expect((statError as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
}

function requireFirstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("stageSandboxMedia scp remote paths", () => {
  it("rejects remote attachment filenames with shell metacharacters before spawning scp", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sessionKey, remoteCacheDir } = createRemoteStageParams(home);
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/evil$(touch pwned).jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      });

      expect(processExecMocks.runCommandWithTimeout).not.toHaveBeenCalled();
      await expectPathMissing(join(remoteCacheDir, basename(remotePath)));
      expect(ctx.media?.[0]?.path).toBe(remotePath);
      expect(sessionCtx.media?.[0]?.path).toBe(remotePath);
      expect(ctx.media?.[0]?.url).toBe(remotePath);
      expect(sessionCtx.media?.[0]?.url).toBe(remotePath);
    });
  });

  it("uses a slugged remote cache directory for session keys with path separators", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir } = createRemoteStageParams(home);
      const sessionKey = "agent:main:explicit:../../escape";
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);
      processExecMocks.runCommandWithTimeout.mockRejectedValue(new Error("stop before scp"));

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      });

      const [command] = requireFirstMockCall(processExecMocks.runCommandWithTimeout, "scp command");
      expect(command).toEqual(expect.arrayContaining(["scp"]));
      const remoteCacheRoot = join(CONFIG_DIR, "media", "remote-cache");
      const expectedSafeDir = join(remoteCacheRoot, slugifySessionKey(sessionKey));
      try {
        const safeDirStats = await fs.stat(expectedSafeDir);
        expect(safeDirStats.isDirectory()).toBe(true);
        await expectPathMissing(join(CONFIG_DIR, "escape"));
      } finally {
        await fs.rm(expectedSafeDir, { recursive: true, force: true });
      }
    });
  });

  it("rewrites remote iMessage attachment metadata to the staged local cache path", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sessionKey } = createRemoteStageParams(home);
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);
      ctx.media = [{ path: remotePath, url: pathToFileURL(remotePath).href }];
      sessionCtx.media = ctx.media;
      processExecMocks.runCommandWithTimeout.mockImplementation(async (argvUnknown) => {
        const argv = argvUnknown as string[];
        const localPath = argv.at(-1);
        if (!localPath) {
          throw new Error("missing scp destination");
        }
        await fs.writeFile(localPath, "staged-image-bytes");
        return { code: 0, stdout: "", stderr: "" };
      });

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      });

      const stagedPath = join(
        CONFIG_DIR,
        "media",
        "remote-cache",
        slugifySessionKey(sessionKey),
        basename(remotePath),
      );
      expect(result.staged.get(0)).toBe(stagedPath);
      expect(ctx.media?.[0]?.path).toBe(stagedPath);
      expect(ctx.media?.[0]?.url).toBe(stagedPath);
      expect(sessionCtx.media?.[0]?.path).toBe(stagedPath);
      expect(sessionCtx.media?.[0]?.url).toBe(stagedPath);
      expect(ctx.media?.[0]).toMatchObject({
        path: stagedPath,
        workspaceDir: join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey)),
      });
      expect(await fs.readFile(stagedPath, "utf8")).toBe("staged-image-bytes");
      await fs.rm(join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey)), {
        recursive: true,
        force: true,
      });
    });
  });

  it("uses absolute remote cache paths in cache mode even when sandbox staging is available", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sessionKey } = createRemoteStageParams(home);
      const sandboxWorkspace = join(home, "sandbox-workspace");
      vi.mocked(sandboxMocks.ensureSandboxWorkspaceForSession).mockResolvedValue({
        workspaceDir: sandboxWorkspace,
        workspaceAccess: "workspace-write",
      });
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);
      ctx.media = [{ path: remotePath }];
      sessionCtx.media = ctx.media;
      processExecMocks.runCommandWithTimeout.mockImplementation(async (argvUnknown) => {
        const argv = argvUnknown as string[];
        const localPath = argv.at(-1);
        if (!localPath) {
          throw new Error("missing scp destination");
        }
        await fs.writeFile(localPath, "staged-image-bytes");
        return { code: 0, stdout: "", stderr: "" };
      });

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
        remoteMediaMode: "cache",
      });

      const stagedPath = join(
        CONFIG_DIR,
        "media",
        "remote-cache",
        slugifySessionKey(sessionKey),
        basename(remotePath),
      );
      expect(result.staged.get(0)).toBe(stagedPath);
      expect(ctx.media?.[0]?.path).toBe(stagedPath);
      expect(ctx.media?.[0]).toMatchObject({
        path: stagedPath,
        workspaceDir: join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey)),
      });
      await expectPathMissing(join(sandboxWorkspace, "media", "inbound", basename(remotePath)));
      expect(await fs.readFile(stagedPath, "utf8")).toBe("staged-image-bytes");
      await fs.rm(join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey)), {
        recursive: true,
        force: true,
      });
    });
  });
});
