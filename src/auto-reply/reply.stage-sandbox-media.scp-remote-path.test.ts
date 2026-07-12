/** Tests sandbox media staging for SCP remote-path inputs. */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const mediaRootMocks = vi.hoisted(() => ({
  resolveChannelRemoteInboundAttachmentRoots: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => sandboxMocks);
vi.mock("../media/channel-inbound-roots.js", () => mediaRootMocks);
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

import {
  appendScpStderrTail,
  SCP_STDERR_TAIL_CHARS,
  stageSandboxMedia,
} from "./reply/stage-sandbox-media.js";

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
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
  it("keeps only the tail of noisy scp stderr", () => {
    const stderr = appendScpStderrTail("start-", `${"x".repeat(SCP_STDERR_TAIL_CHARS)}-end`);

    expect(stderr).toHaveLength(SCP_STDERR_TAIL_CHARS);
    expect(stderr).toContain("-end");
    expect(stderr).not.toContain("start-");
  });

  it("keeps scp stderr tail UTF-16 safe when the boundary bisects an emoji", () => {
    const stderr = appendScpStderrTail("prefix", "🤖tail", 5);

    expect(stderr).toBe("tail");
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(stderr),
    ).toBe(false);
  });

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

      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
      await expectPathMissing(join(remoteCacheDir, basename(remotePath)));
      expect(ctx.MediaPath).toBe(remotePath);
      expect(sessionCtx.MediaPath).toBe(remotePath);
      expect(ctx.MediaUrl).toBe(remotePath);
      expect(sessionCtx.MediaUrl).toBe(remotePath);
    });
  });

  it("uses a slugged remote cache directory for session keys with path separators", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir } = createRemoteStageParams(home);
      const sessionKey = "agent:main:explicit:../../escape";
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);
      childProcessMocks.spawn.mockImplementation(() => {
        throw new Error("stop before scp");
      });

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      });

      const [command] = requireFirstMockCall(childProcessMocks.spawn, "scp spawn");
      expect(command).toBe("scp");
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
      ctx.MediaPaths = [remotePath];
      sessionCtx.MediaPaths = [remotePath];
      childProcessMocks.spawn.mockImplementation((_command, argsUnknown) => {
        const args = argsUnknown as string[];
        const localPath = expectDefined(
          args[args.length - 1],
          "args[args.length - 1] test invariant",
        );
        const child = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter & { setEncoding: (_encoding: string) => void };
        };
        child.stderr = Object.assign(new EventEmitter(), {
          setEncoding: () => undefined,
        });
        queueMicrotask(() => {
          void fs.writeFile(localPath, "staged-image-bytes").then(() => {
            child.emit("close", 0);
          });
        });
        return child;
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
      expect(result.staged.get(remotePath)).toBe(stagedPath);
      expect(ctx.MediaPath).toBe(stagedPath);
      expect(ctx.MediaPaths).toEqual([stagedPath]);
      expect(ctx.MediaUrl).toBe(stagedPath);
      expect(sessionCtx.MediaPath).toBe(stagedPath);
      expect(sessionCtx.MediaPaths).toEqual([stagedPath]);
      expect(sessionCtx.MediaUrl).toBe(stagedPath);
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
      ctx.MediaPaths = [remotePath];
      sessionCtx.MediaPaths = [remotePath];
      childProcessMocks.spawn.mockImplementation((_command, argsUnknown) => {
        const args = argsUnknown as string[];
        const localPath = expectDefined(
          args[args.length - 1],
          "args[args.length - 1] test invariant",
        );
        const child = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter & { setEncoding: (_encoding: string) => void };
        };
        child.stderr = Object.assign(new EventEmitter(), {
          setEncoding: () => undefined,
        });
        queueMicrotask(() => {
          void fs.writeFile(localPath, "staged-image-bytes").then(() => {
            child.emit("close", 0);
          });
        });
        return child;
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
      expect(result.staged.get(remotePath)).toBe(stagedPath);
      expect(ctx.MediaPath).toBe(stagedPath);
      expect(ctx.MediaPaths).toEqual([stagedPath]);
      await expectPathMissing(join(sandboxWorkspace, "media", "inbound", basename(remotePath)));
      expect(await fs.readFile(stagedPath, "utf8")).toBe("staged-image-bytes");
      await fs.rm(join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey)), {
        recursive: true,
        force: true,
      });
    });
  });
});
