import fs from "node:fs/promises";
import { basename, join } from "node:path";
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

import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";

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

      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
      await expect(fs.stat(join(remoteCacheDir, basename(remotePath)))).rejects.toThrow();
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

      expect(childProcessMocks.spawn.mock.calls[0]?.[0]).toBe("scp");
      const remoteCacheRoot = join(CONFIG_DIR, "media", "remote-cache");
      const expectedSafeDir = join(remoteCacheRoot, slugifySessionKey(sessionKey));
      try {
        const safeDirStats = await fs.stat(expectedSafeDir);
        expect(safeDirStats.isDirectory()).toBe(true);
        await expect(fs.stat(join(CONFIG_DIR, "escape"))).rejects.toThrow();
      } finally {
        await fs.rm(expectedSafeDir, { recursive: true, force: true });
      }
    });
  });
});
