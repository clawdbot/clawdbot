import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveSandboxedMediaSource } from "./sandbox-paths.js";

async function withSandboxRoot<T>(run: (sandboxDir: string) => Promise<T>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
  try {
    return await run(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function expectSandboxRejection(media: string, sandboxRoot: string, pattern: RegExp) {
  await expect(resolveSandboxedMediaSource({ media, sandboxRoot })).rejects.toThrow(pattern);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function makeTmpProbePath(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
}

async function withOutsideHardlinkInOpenClawTmp<T>(
  params: {
    openClawTmpDir: string;
    hardlinkPrefix: string;
    symlinkPrefix?: string;
  },
  run: (paths: { hardlinkPath: string; symlinkPath?: string }) => Promise<T>,
): Promise<void> {
  const outsideDir = await fs.mkdtemp(path.join(process.cwd(), "sandbox-media-hardlink-outside-"));
  const outsideFile = path.join(outsideDir, "outside-secret.txt");
  const hardlinkPath = path.join(params.openClawTmpDir, makeTmpProbePath(params.hardlinkPrefix));
  const symlinkPath = params.symlinkPrefix
    ? path.join(params.openClawTmpDir, makeTmpProbePath(params.symlinkPrefix))
    : undefined;
  try {
    if (isPathInside(params.openClawTmpDir, outsideFile)) {
      return;
    }
    await fs.writeFile(outsideFile, "secret", "utf8");
    await fs.mkdir(params.openClawTmpDir, { recursive: true });
    try {
      await fs.link(outsideFile, hardlinkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }
    if (symlinkPath) {
      await fs.symlink(hardlinkPath, symlinkPath);
    }
    await run({ hardlinkPath, symlinkPath });
  } finally {
    if (symlinkPath) {
      await fs.rm(symlinkPath, { force: true });
    }
    await fs.rm(hardlinkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
}

describe("resolveSandboxedMediaSource", () => {
  const openClawTmpDir = resolvePreferredOpenClawTmpDir();

  // Group 1: /tmp paths (the bug fix)
  it.each([
    {
      name: "absolute paths under preferred OpenClaw tmp root",
      media: path.join(openClawTmpDir, "image.png"),
      expected: path.join(openClawTmpDir, "image.png"),
    },
    {
      name: "file:// URLs pointing to preferred OpenClaw tmp root",
      media: pathToFileURL(path.join(openClawTmpDir, "photo.png")).href,
      expected: path.join(openClawTmpDir, "photo.png"),
    },
    {
      name: "nested paths under preferred OpenClaw tmp root",
      media: path.join(openClawTmpDir, "subdir", "deep", "file.png"),
      expected: path.join(openClawTmpDir, "subdir", "deep", "file.png"),
    },
  ])("allows $name", async ({ media, expected }) => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media,
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.resolve(expected));
    });
  });

  // Group 2: Sandbox-relative paths (existing behavior)
  it("resolves sandbox-relative paths", async () => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media: "./data/file.txt",
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(sandboxDir, "data", "file.txt"));
    });
  });

  it("maps container /workspace absolute paths into sandbox root", async () => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media: "/workspace/media/pic.png",
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(sandboxDir, "media", "pic.png"));
    });
  });

  it("maps file:// URLs under /workspace into sandbox root", async () => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media: "file:///workspace/media/pic.png",
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(sandboxDir, "media", "pic.png"));
    });
  });

  it("preserves remote mxc:// media sources", async () => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media: "mxc://matrix.org/abc123def456",
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe("mxc://matrix.org/abc123def456");
    });
  });

  // Group 3: Rejections (security)
  it.each([
    {
      name: "paths outside sandbox root and tmpdir",
      media: "/etc/passwd",
      expected: /sandbox/i,
    },
    {
      name: "paths under similarly named container roots",
      media: "/workspace-two/secret.txt",
      expected: /sandbox/i,
    },
    {
      name: "path traversal through tmpdir",
      media: path.join(openClawTmpDir, "..", "etc", "passwd"),
      expected: /sandbox/i,
    },
    {
      name: "absolute paths under host tmp outside openclaw tmp root",
      media: path.join(os.tmpdir(), "outside-openclaw", "passwd"),
      expected: /sandbox/i,
    },
    {
      name: "relative traversal outside sandbox",
      media: "../outside-sandbox.png",
      expected: /sandbox/i,
    },
    {
      name: "file:// URLs outside sandbox",
      media: "file:///etc/passwd",
      expected: /sandbox/i,
    },
    {
      name: "file:// URLs with remote hosts",
      media: "file://attacker/share/photo.png",
      expected: /remote hosts are not allowed/i,
    },
    {
      name: "file:// container URLs with remote hosts",
      media: "file://attacker/workspace/photo.png",
      expected: /remote hosts are not allowed/i,
    },
    {
      name: "invalid file:// URLs",
      media: "file://not a valid url\x00",
      expected: /Invalid file:\/\/ URL/,
    },
    {
      name: "file:// URLs with malformed container pathname encoding",
      media: "file:///workspace/%E0%A4%A",
      expected: /Invalid file:\/\/ URL/,
    },
    {
      name: "file:// URLs with encoded separators in the pathname",
      media: "file:///workspace/%2FREADME.md",
      expected: /cannot encode path separators/i,
    },
  ])("rejects $name", async ({ media, expected }) => {
    await withSandboxRoot(async (sandboxDir) => {
      await expectSandboxRejection(media, sandboxDir, expected);
    });
  });

  it("rejects symlinked OpenClaw tmp paths escaping tmp root", async () => {
    if (process.platform === "win32") {
      return;
    }
    const outsideTmpTarget = path.resolve(process.cwd(), "package.json");
    if (isPathInside(openClawTmpDir, outsideTmpTarget)) {
      return;
    }

    await withSandboxRoot(async (sandboxDir) => {
      await fs.access(outsideTmpTarget);
      await fs.mkdir(openClawTmpDir, { recursive: true });
      const symlinkPath = path.join(openClawTmpDir, `tmp-link-escape-${process.pid}`);
      await fs.symlink(outsideTmpTarget, symlinkPath);
      try {
        await expectSandboxRejection(symlinkPath, sandboxDir, /symlink|sandbox/i);
      } finally {
        await fs.unlink(symlinkPath).catch(() => {});
      }
    });
  });

  it("rejects sandbox symlink escapes when the outside leaf does not exist yet", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withSandboxRoot(async (sandboxDir) => {
      const outsideDir = await fs.mkdtemp(
        path.join(process.cwd(), "sandbox-media-outside-missing-"),
      );
      const linkDir = path.join(sandboxDir, "escape-link");
      await fs.symlink(outsideDir, linkDir);
      try {
        const missingOutsidePath = path.join(linkDir, "new-file.txt");
        await expectSandboxRejection(missingOutsidePath, sandboxDir, /symlink|sandbox/i);
      } finally {
        await fs.rm(linkDir, { force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects hardlinked OpenClaw tmp paths to outside files", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOutsideHardlinkInOpenClawTmp(
      {
        openClawTmpDir,
        hardlinkPrefix: "sandbox-media-hardlink",
      },
      async ({ hardlinkPath }) => {
        await withSandboxRoot(async (sandboxDir) => {
          await expectSandboxRejection(hardlinkPath, sandboxDir, /hard.?link|sandbox/i);
        });
      },
    );
  });

  it("rejects symlinked OpenClaw tmp paths to hardlinked outside files", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOutsideHardlinkInOpenClawTmp(
      {
        openClawTmpDir,
        hardlinkPrefix: "sandbox-media-hardlink-target",
        symlinkPrefix: "sandbox-media-hardlink-symlink",
      },
      async ({ symlinkPath }) => {
        if (!symlinkPath) {
          return;
        }
        await withSandboxRoot(async (sandboxDir) => {
          await expectSandboxRejection(symlinkPath, sandboxDir, /hard.?link|sandbox/i);
        });
      },
    );
  });

  // Group 4: Passthrough
  it("passes HTTP URLs through unchanged", async () => {
    const result = await resolveSandboxedMediaSource({
      media: "https://example.com/image.png",
      sandboxRoot: "/any/path",
    });
    expect(result).toBe("https://example.com/image.png");
  });

  it("returns empty string for empty input", async () => {
    const result = await resolveSandboxedMediaSource({
      media: "",
      sandboxRoot: "/any/path",
    });
    expect(result).toBe("");
  });

  it("returns empty string for whitespace-only input", async () => {
    const result = await resolveSandboxedMediaSource({
      media: "   ",
      sandboxRoot: "/any/path",
    });
    expect(result).toBe("");
  });

  it("rejects Windows network paths before sandbox resolution", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await expect(
        resolveSandboxedMediaSource({
          media: "\\\\attacker\\share\\photo.png",
          sandboxRoot: "/any/path",
        }),
      ).rejects.toThrow(/network paths/i);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
