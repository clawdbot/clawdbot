import { describe, expect, it, vi } from "vitest";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "./sandbox-media-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

describe("createSandboxBridgeReadFile", () => {
  it("delegates reads through the sandbox bridge with sandbox root cwd", async () => {
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const scopedRead = createSandboxBridgeReadFile({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          readFile,
        } as unknown as SandboxFsBridge,
      },
    });
    await expect(scopedRead("media/inbound/example.png")).resolves.toEqual(Buffer.from("ok"));
    expect(readFile).toHaveBeenCalledWith({
      filePath: "media/inbound/example.png",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("falls back to container paths when the bridge has no host path", async () => {
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));
    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          resolvePath: ({ filePath }: { filePath: string }) => ({
            relativePath: filePath,
            containerPath: `/sandbox/${filePath}`,
          }),
          stat,
        } as unknown as SandboxFsBridge,
      },
      mediaPath: "image.png",
    });

    expect(resolved).toEqual({ resolved: "/sandbox/image.png" });
    expect(stat).not.toHaveBeenCalled();
  });

  it("rewrites inbound media URIs before direct sandbox resolution", async () => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      hostPath: `/tmp/sandbox-root/${filePath}`,
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }));
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          resolvePath,
          stat,
        } as unknown as SandboxFsBridge,
      },
      mediaPath: "media://inbound/photo.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(stat).toHaveBeenCalledWith({
      filePath: "media/inbound/photo.png",
      cwd: "/tmp/sandbox-root",
    });
    expect(resolvePath).toHaveBeenCalledWith({
      filePath: "media/inbound/photo.png",
      cwd: "/tmp/sandbox-root",
    });
    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/photo.png",
      rewrittenFrom: "media://inbound/photo.png",
    });
  });

  it("rejects missing staged inbound media URIs before direct sandbox resolution", async () => {
    const resolvePath = vi.fn();
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: {
          root: "/tmp/sandbox-root",
          bridge: {
            resolvePath,
            stat: vi.fn(async () => null),
          } as unknown as SandboxFsBridge,
        },
        mediaPath: "media://inbound/missing.png",
        inboundFallbackDir: "media/inbound",
      }),
    ).rejects.toThrow("Sandbox media reference is not staged: media://inbound/missing.png");
    expect(resolvePath).not.toHaveBeenCalled();
  });
});
