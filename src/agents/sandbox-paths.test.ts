// Verifies sandbox media path admission for workspace, tmp, managed, and remote sources.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  assertSandboxPath,
  resolveAllowedManagedMediaPath,
  resolveSandboxedMediaSource,
  resolveSandboxPath,
} from "./sandbox-paths.js";

async function withSandboxRoot<T>(run: (sandboxDir: string) => Promise<T>) {
  // Real temp roots exercise path normalization and symlink/hardlink behavior.
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

async function withManagedMediaRoot<T>(run: (ctx: { stateDir: string }) => Promise<T>) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-media-"));
  try {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await fs.mkdir(path.join(stateDir, "media", "outbound"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "media", "tool-file-transfer"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "media", "tool-image-generation"), { recursive: true });
      return await run({ stateDir });
    });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function withOutsideHardlinkInOpenClawTmp<T>(
  params: {
    openClawTmpDir: string;
    hardlinkPrefix: string;
    symlinkPrefix?: string;
  },
  run: (paths: { hardlinkPath: string; symlinkPath?: string }) => Promise<T>,
): Promise<void> {
  // Hardlinks in allowed temp roots must still be rejected when inode points outside.
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

describe("resolveSandboxPath", () => {
  it("keeps home-sibling roots absolute in escape diagnostics", async () => {
    const home = path.join(os.homedir(), "test-home");
    await withEnvAsync({ HOME: home, OPENCLAW_HOME: undefined }, async () => {
      const root = path.resolve(`${home}-sibling`);
      const outside = path.dirname(root);

      expect(() => resolveSandboxPath({ filePath: outside, cwd: root, root })).toThrow(
        `Path escapes sandbox root (${root}): ${outside}`,
      );
    });
  });

  it("still shortens roots beneath the home directory", async () => {
    const home = path.join(os.homedir(), "test-home");
    await withEnvAsync({ HOME: home, OPENCLAW_HOME: undefined }, async () => {
      const root = path.join(home, "openclaw-sandbox");
      const outside = path.dirname(root);

      expect(() => resolveSandboxPath({ filePath: outside, cwd: root, root })).toThrow(
        `Path escapes sandbox root (~${path.sep}openclaw-sandbox): ${outside}`,
      );
    });
  });
});

describe("assertSandboxPath", () => {
  it.runIf(process.platform !== "win32")(
    "rejects symlink-then-dot-dot traversal for existing and new files",
    async () => {
      const parent = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-symlink-dotdot-")),
      );
      const root = path.join(parent, "workspace");
      const outside = path.join(parent, "outside");
      try {
        await fs.mkdir(path.join(root, "sub"), { recursive: true });
        await fs.mkdir(outside);
        await fs.symlink("..", path.join(root, "sub", "up"));
        await fs.writeFile(path.join(outside, "secret.txt"), "outside", "utf8");

        const escapedRead = `${root}/sub/up/../outside/secret.txt`;
        await expect(fs.readFile(escapedRead, "utf8")).resolves.toBe("outside");
        await expect(assertSandboxPath({ filePath: escapedRead, cwd: root, root })).rejects.toThrow(
          /(?:resolves outside|escapes) sandbox root/i,
        );
        await expect(
          assertSandboxPath({
            filePath: `${root}/sub/up/../outside/new.txt`,
            cwd: root,
            root,
          }),
        ).rejects.toThrow(/(?:resolves outside|escapes) sandbox root/i);
        await expect(
          assertSandboxPath({ filePath: `${root}/sub/up/../..`, cwd: root, root }),
        ).rejects.toThrow(/(?:resolves outside|escapes) sandbox root/i);

        await fs.mkdir(path.join(root, "a"));
        await fs.mkdir(path.join(root, "b"));
        await fs.symlink("../b", path.join(root, "a", "up"));
        await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "escape"));
        const escapedFinalSymlink = `${root}/a/up/../escape`;
        await expect(fs.readFile(escapedFinalSymlink, "utf8")).resolves.toBe("outside");
        await expect(
          assertSandboxPath({ filePath: escapedFinalSymlink, cwd: root, root }),
        ).rejects.toThrow(/symlink escapes sandbox root/i);

        await fs.symlink(outside, path.join(root, "outside-link"));
        await expect(
          assertSandboxPath({
            filePath: `${root}/outside-link/`,
            cwd: root,
            root,
            allowFinalSymlinkForUnlink: true,
          }),
        ).rejects.toThrow(/escapes sandbox root/i);

        await fs.mkdir(path.join(root, "real"));
        await fs.symlink(path.join(root, "real"), path.join(root, "in-root-link"));
        await expect(
          assertSandboxPath({
            filePath: `${root}/in-root-link/../real/new.txt`,
            cwd: root,
            root,
          }),
        ).resolves.toBeTruthy();
        await expect(assertSandboxPath({ filePath: root, cwd: root, root })).resolves.toBeTruthy();
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("accepts not-yet-created and symlinked roots", async () => {
    const parent = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-missing-root-")),
    );
    try {
      const root = path.join(parent, "workspace");
      await expect(
        assertSandboxPath({ filePath: "nested/new.txt", cwd: root, root }),
      ).resolves.toMatchObject({ relative: path.join("nested", "new.txt") });

      const realRoot = path.join(parent, "real-workspace");
      const linkedRoot = path.join(parent, "linked-workspace");
      await fs.mkdir(realRoot);
      await fs.symlink(realRoot, linkedRoot);
      await expect(
        assertSandboxPath({ filePath: linkedRoot, cwd: linkedRoot, root: linkedRoot }),
      ).resolves.toMatchObject({ relative: "" });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

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

  it.each([
    {
      name: "managed outbound media",
      relative: path.join("media", "outbound", "reply.png"),
    },
    {
      name: "managed file-transfer tool media",
      relative: path.join("media", "tool-file-transfer", "fetched.png"),
    },
    {
      name: "managed tool media",
      relative: path.join("media", "tool-image-generation", "generated.png"),
    },
  ])("allows $name outside the sandbox root", async ({ relative }) => {
    await withManagedMediaRoot(async ({ stateDir }) => {
      await withSandboxRoot(async (sandboxDir) => {
        const media = path.join(stateDir, relative);
        await fs.writeFile(media, "image", "utf8");

        const result = await resolveSandboxedMediaSource({
          media,
          sandboxRoot: sandboxDir,
        });

        expect(result).toBe(media);
      });
    });
  });

  it("resolves checked managed media paths for non-sandbox callers", async () => {
    await withManagedMediaRoot(async ({ stateDir }) => {
      const media = path.join(stateDir, "media", "outbound", "reply.png");
      await fs.writeFile(media, "image", "utf8");

      await expect(resolveAllowedManagedMediaPath(media)).resolves.toBe(media);
    });
  });

  it("does not allow unrelated state media directories as managed media", async () => {
    await withManagedMediaRoot(async ({ stateDir }) => {
      const media = path.join(stateDir, "media", "inbound", "reply.png");
      await fs.mkdir(path.dirname(media), { recursive: true });
      await fs.writeFile(media, "image", "utf8");

      await expect(resolveAllowedManagedMediaPath(media)).resolves.toBeUndefined();
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

  it("allows dot-dot-prefixed filenames inside the sandbox root", async () => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media: "./..image.png",
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(sandboxDir, "..image.png"));
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

  it.each(["outbound", "tool-file-transfer"])(
    "rejects symlinked managed media paths escaping the %s root",
    async (subdir) => {
      if (process.platform === "win32") {
        return;
      }
      await withManagedMediaRoot(async ({ stateDir }) => {
        await withSandboxRoot(async (sandboxDir) => {
          const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-media-outside-"));
          const outsideFile = path.join(outsideDir, "secret.png");
          const symlinkPath = path.join(stateDir, "media", subdir, "linked-secret.png");
          try {
            await fs.writeFile(outsideFile, "secret", "utf8");
            await fs.symlink(outsideFile, symlinkPath);

            await expectSandboxRejection(symlinkPath, sandboxDir, /managed media root|symlink/i);
          } finally {
            await fs.rm(symlinkPath, { force: true });
            await fs.rm(outsideDir, { recursive: true, force: true });
          }
        });
      });
    },
  );

  it.each(["outbound", "tool-file-transfer"])(
    "rejects checked managed media symlinks escaping the %s root",
    async (subdir) => {
      if (process.platform === "win32") {
        return;
      }
      await withManagedMediaRoot(async ({ stateDir }) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-media-outside-"));
        const outsideFile = path.join(outsideDir, "secret.png");
        const symlinkPath = path.join(stateDir, "media", subdir, "linked-secret.png");
        try {
          await fs.writeFile(outsideFile, "secret", "utf8");
          await fs.symlink(outsideFile, symlinkPath);

          await expect(resolveAllowedManagedMediaPath(symlinkPath)).rejects.toThrow(
            /managed media root|symlink/i,
          );
        } finally {
          await fs.rm(symlinkPath, { force: true });
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      });
    },
  );

  it("rejects hardlinked file-transfer media that aliases a file outside managed media", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withManagedMediaRoot(async ({ stateDir }) => {
      await withSandboxRoot(async (sandboxDir) => {
        const outsideDir = await fs.mkdtemp(
          path.join(path.dirname(stateDir), "managed-media-hardlink-outside-"),
        );
        const outsideFile = path.join(outsideDir, "secret.png");
        const hardlinkPath = path.join(
          stateDir,
          "media",
          "tool-file-transfer",
          "linked-secret.png",
        );
        try {
          await fs.writeFile(outsideFile, "secret", "utf8");
          try {
            await fs.link(outsideFile, hardlinkPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EXDEV") {
              return;
            }
            throw err;
          }

          await expect(resolveAllowedManagedMediaPath(hardlinkPath)).rejects.toThrow(/hard.?link/i);
          await expectSandboxRejection(hardlinkPath, sandboxDir, /hard.?link|managed media root/i);
        } finally {
          await fs.rm(hardlinkPath, { force: true });
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      });
    });
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
