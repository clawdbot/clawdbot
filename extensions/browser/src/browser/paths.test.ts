// Browser tests cover paths plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveExistingPathsWithinRoot,
  resolveExistingUploadPaths,
  resolvePathsWithinRoot,
  resolvePathWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveStrictExistingUploadPaths,
  resolveWritablePathWithinRoot,
} from "./paths.js";

async function createFixtureRoot(): Promise<{
  baseDir: string;
  inboundMediaDir: string;
  uploadsDir: string;
}> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-paths-"));
  const uploadsDir = path.join(baseDir, "uploads");
  const inboundMediaDir = path.join(baseDir, "media", "inbound");
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(inboundMediaDir, { recursive: true });
  return { baseDir, inboundMediaDir, uploadsDir };
}

async function withFixtureRoot<T>(
  run: (ctx: { baseDir: string; inboundMediaDir: string; uploadsDir: string }) => Promise<T>,
): Promise<T> {
  const fixture = await createFixtureRoot();
  try {
    return await run(fixture);
  } finally {
    await fs.rm(fixture.baseDir, { recursive: true, force: true });
  }
}

async function createAliasedUploadsRoot(baseDir: string): Promise<{
  canonicalUploadsDir: string;
  aliasedUploadsDir: string;
}> {
  const canonicalUploadsDir = path.join(baseDir, "canonical", "uploads");
  const aliasedUploadsDir = path.join(baseDir, "uploads-link");
  await fs.mkdir(canonicalUploadsDir, { recursive: true });
  await fs.symlink(canonicalUploadsDir, aliasedUploadsDir);
  return { canonicalUploadsDir, aliasedUploadsDir };
}

describe("resolveExistingPathsWithinRoot", () => {
  function expectInvalidResult(
    result: Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>,
    expectedSnippet: string,
  ) {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(expectedSnippet);
    }
  }

  function resolveWithinUploads(params: {
    uploadsDir: string;
    requestedPaths: string[];
  }): Promise<Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>> {
    return resolveExistingPathsWithinRoot({
      rootDir: params.uploadsDir,
      requestedPaths: params.requestedPaths,
      scopeLabel: "uploads directory",
    });
  }

  it("accepts existing files under the upload root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const nestedDir = path.join(uploadsDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });
      const filePath = path.join(nestedDir, "ok.txt");
      await fs.writeFile(filePath, "ok", "utf8");

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: [filePath],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(filePath)]);
      }
    });
  });

  it("rejects traversal outside the upload root", async () => {
    await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
      const outsidePath = path.join(baseDir, "outside.txt");
      await fs.writeFile(outsidePath, "nope", "utf8");

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["../outside.txt"],
      });

      expectInvalidResult(result, "must stay within uploads directory");
    });
  });

  it("rejects blank paths", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["  "],
      });

      expectInvalidResult(result, "path is required");
    });
  });

  it("keeps lexical in-root paths when files do not exist yet", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["missing.txt"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([path.join(uploadsDir, "missing.txt")]);
      }
    });
  });

  it("rejects directory paths inside upload root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const nestedDir = path.join(uploadsDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["nested"],
      });

      expectInvalidResult(result, "regular non-symlink file");
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink escapes outside upload root",
    async () => {
      await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
        const outsidePath = path.join(baseDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");
        const symlinkPath = path.join(uploadsDir, "leak.txt");
        await fs.symlink(outsidePath, symlinkPath);

        const result = await resolveWithinUploads({
          uploadsDir,
          requestedPaths: ["leak.txt"],
        });

        expectInvalidResult(result, "regular non-symlink file");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns outside-root message for files reached via escaping symlinked directories",
    async () => {
      await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
        const outsideDir = path.join(baseDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
        await fs.symlink(outsideDir, path.join(uploadsDir, "alias"));

        const result = await resolveWithinUploads({
          uploadsDir,
          requestedPaths: ["alias/secret.txt"],
        });

        expect(result).toEqual({
          ok: false,
          error: "File is outside uploads directory",
        });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts canonical absolute paths when upload root is a symlink alias",
    async () => {
      await withFixtureRoot(async ({ baseDir }) => {
        const { canonicalUploadsDir, aliasedUploadsDir } = await createAliasedUploadsRoot(baseDir);

        const filePath = path.join(canonicalUploadsDir, "ok.txt");
        await fs.writeFile(filePath, "ok", "utf8");
        const canonicalPath = await fs.realpath(filePath);

        const firstPass = await resolveWithinUploads({
          uploadsDir: aliasedUploadsDir,
          requestedPaths: [path.join(aliasedUploadsDir, "ok.txt")],
        });
        expect(firstPass.ok).toBe(true);

        const secondPass = await resolveWithinUploads({
          uploadsDir: aliasedUploadsDir,
          requestedPaths: [canonicalPath],
        });
        expect(secondPass.ok).toBe(true);
        if (secondPass.ok) {
          expect(secondPass.paths).toEqual([canonicalPath]);
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects canonical absolute paths outside symlinked upload root",
    async () => {
      await withFixtureRoot(async ({ baseDir }) => {
        const { aliasedUploadsDir } = await createAliasedUploadsRoot(baseDir);

        const outsideDir = path.join(baseDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "secret", "utf8");

        const result = await resolveWithinUploads({
          uploadsDir: aliasedUploadsDir,
          requestedPaths: [await fs.realpath(outsideFile)],
        });
        expectInvalidResult(result, "must stay within uploads directory");
      });
    },
  );
});

describe("resolveExistingUploadPaths", () => {
  it("falls back to inbound media when the uploads root rejects the file", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.writeFile(inboundFile, "pdf", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: [inboundFile],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(inboundFile)]);
      }
    });
  });

  it("resolves canonical inbound media URI references before root validation", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.writeFile(inboundFile, "pdf", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media://inbound/report.pdf"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(inboundFile)]);
      }
    });
  });

  it("falls back to sandbox-relative inbound media paths after root validation", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.writeFile(inboundFile, "pdf", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media/inbound/report.pdf"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(inboundFile)]);
      }
    });
  });

  it("keeps upload-root paths before sandbox-relative inbound media fallback", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const uploadFile = path.join(uploadsDir, "media", "inbound", "report.pdf");
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.mkdir(path.dirname(uploadFile), { recursive: true });
      await fs.writeFile(uploadFile, "upload", "utf8");
      await fs.writeFile(inboundFile, "inbound", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media/inbound/report.pdf"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(uploadFile)]);
      }
    });
  });

  it("accepts mixed upload-root and inbound-media files in one request", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const uploadFile = path.join(uploadsDir, "from-upload.txt");
      const inboundFile = path.join(inboundMediaDir, "from-inbound.txt");
      await fs.writeFile(uploadFile, "upload", "utf8");
      await fs.writeFile(inboundFile, "inbound", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: [uploadFile, "media://inbound/from-inbound.txt"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([
          await fs.realpath(uploadFile),
          await fs.realpath(inboundFile),
        ]);
      }
    });
  });

  it("rejects nested inbound media URI references", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media://inbound/nested%2Fsecret.pdf"],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid media reference");
      }
    });
  });

  it("rejects traversal-shaped inbound media URI references before URL normalization", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.writeFile(inboundFile, "pdf", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media://inbound/nested/../report.pdf"],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid media reference");
      }
    });
  });

  it("rejects nested absolute inbound media paths", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const nestedDir = path.join(inboundMediaDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });
      const nestedFile = path.join(nestedDir, "secret.pdf");
      await fs.writeFile(nestedFile, "secret", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: [nestedFile],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("direct child of inbound media directory");
      }
    });
  });

  it("rejects files outside both managed upload roots", async () => {
    await withFixtureRoot(async ({ baseDir, inboundMediaDir, uploadsDir }) => {
      const outsideFile = path.join(baseDir, "secret.txt");
      await fs.writeFile(outsideFile, "secret", "utf8");

      const result = await resolveExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: [outsideFile],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("inbound media directory");
      }
    });
  });
});

describe("resolveStrictExistingPathsWithinRoot", () => {
  function expectInvalidResult(
    result: Awaited<ReturnType<typeof resolveStrictExistingPathsWithinRoot>>,
    expectedSnippet: string,
  ) {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(expectedSnippet);
    }
  }

  it("rejects missing files instead of returning lexical fallbacks", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveStrictExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: ["missing.txt"],
        scopeLabel: "uploads directory",
      });
      expectInvalidResult(result, "regular non-symlink file");
    });
  });
});

describe("resolveStrictExistingUploadPaths", () => {
  it("falls back to inbound media for use-time upload validation", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.writeFile(inboundFile, "pdf", "utf8");

      const result = await resolveStrictExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: [inboundFile],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(inboundFile)]);
      }
    });
  });

  it("resolves inbound media URI references for use-time upload validation", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.writeFile(inboundFile, "pdf", "utf8");

      const result = await resolveStrictExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media://inbound/report.pdf"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(inboundFile)]);
      }
    });
  });

  it("falls back to sandbox-relative inbound media paths for use-time upload validation", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.writeFile(inboundFile, "pdf", "utf8");

      const result = await resolveStrictExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media/inbound/report.pdf"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(inboundFile)]);
      }
    });
  });

  it("keeps upload-root paths before sandbox-relative inbound media fallback at use time", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const uploadFile = path.join(uploadsDir, "media", "inbound", "report.pdf");
      const inboundFile = path.join(inboundMediaDir, "report.pdf");
      await fs.mkdir(path.dirname(uploadFile), { recursive: true });
      await fs.writeFile(uploadFile, "upload", "utf8");
      await fs.writeFile(inboundFile, "inbound", "utf8");

      const result = await resolveStrictExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["media/inbound/report.pdf"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(uploadFile)]);
      }
    });
  });

  it("accepts mixed upload-root and inbound-media files at use time", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const uploadFile = path.join(uploadsDir, "from-upload.txt");
      const inboundFile = path.join(inboundMediaDir, "from-inbound.txt");
      await fs.writeFile(uploadFile, "upload", "utf8");
      await fs.writeFile(inboundFile, "inbound", "utf8");

      const result = await resolveStrictExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: [uploadFile, "media/inbound/from-inbound.txt"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([
          await fs.realpath(uploadFile),
          await fs.realpath(inboundFile),
        ]);
      }
    });
  });

  it("rejects files missing from both managed upload roots", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const result = await resolveStrictExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: ["missing.txt"],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("regular non-symlink file");
      }
    });
  });

  it("rejects nested absolute inbound media paths at use time", async () => {
    await withFixtureRoot(async ({ inboundMediaDir, uploadsDir }) => {
      const nestedDir = path.join(inboundMediaDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });
      const nestedFile = path.join(nestedDir, "secret.pdf");
      await fs.writeFile(nestedFile, "secret", "utf8");

      const result = await resolveStrictExistingUploadPaths({
        uploadDir: uploadsDir,
        inboundMediaDir,
        requestedPaths: [nestedFile],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("direct child of inbound media directory");
      }
    });
  });
});

describe("resolvePathWithinRoot", () => {
  it("uses default file name when requested path is blank", () => {
    const result = resolvePathWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPath: " ",
      scopeLabel: "uploads directory",
      defaultFileName: "fallback.txt",
    });
    expect(result).toEqual({
      ok: true,
      path: path.resolve("/tmp/uploads", "fallback.txt"),
    });
  });

  it("rejects root-level path aliases that do not point to a file", () => {
    const result = resolvePathWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPath: ".",
      scopeLabel: "uploads directory",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must stay within uploads directory");
    }
  });
});

describe("resolveWritablePathWithinRoot", () => {
  it("accepts a writable path under root when parent is a real directory", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveWritablePathWithinRoot({
        rootDir: uploadsDir,
        requestedPath: "safe.txt",
        scopeLabel: "uploads directory",
      });
      expect(result).toEqual({
        ok: true,
        path: path.resolve(uploadsDir, "safe.txt"),
      });
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects write paths routed through a symlinked parent directory",
    async () => {
      await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
        const outsideDir = path.join(baseDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        const symlinkDir = path.join(uploadsDir, "escape-link");
        await fs.symlink(outsideDir, symlinkDir);

        const result = await resolveWritablePathWithinRoot({
          rootDir: uploadsDir,
          requestedPath: "escape-link/pwned.txt",
          scopeLabel: "uploads directory",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("must stay within uploads directory");
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects existing hardlinked files under root",
    async () => {
      await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
        const outsidePath = path.join(baseDir, "outside-target.txt");
        await fs.writeFile(outsidePath, "outside", "utf8");
        const hardlinkedPath = path.join(uploadsDir, "linked.txt");
        await fs.link(outsidePath, hardlinkedPath);

        const result = await resolveWritablePathWithinRoot({
          rootDir: uploadsDir,
          requestedPath: "linked.txt",
          scopeLabel: "uploads directory",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("must stay within uploads directory");
        }
      });
    },
  );
});

describe("resolvePathsWithinRoot", () => {
  it("resolves all valid in-root paths", () => {
    const result = resolvePathsWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPaths: ["a.txt", "nested/b.txt"],
      scopeLabel: "uploads directory",
    });
    expect(result).toEqual({
      ok: true,
      paths: [path.resolve("/tmp/uploads", "a.txt"), path.resolve("/tmp/uploads", "nested/b.txt")],
    });
  });

  it("returns the first path validation error", () => {
    const result = resolvePathsWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPaths: ["a.txt", "../outside.txt", "b.txt"],
      scopeLabel: "uploads directory",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must stay within uploads directory");
    }
  });
});
