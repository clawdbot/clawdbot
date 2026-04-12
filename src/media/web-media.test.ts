import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

let loadWebMedia: typeof import("./web-media.js").loadWebMedia;

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

let fixtureRoot = "";
let tinyPngFile = "";
let stateDir = "";
let canvasPngFile = "";
let workspaceDir = "";
let workspacePngFile = "";

beforeAll(async () => {
  ({ loadWebMedia } = await import("./web-media.js"));
  fixtureRoot = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "web-media-core-"));
  tinyPngFile = path.join(fixtureRoot, "tiny.png");
  await fs.writeFile(tinyPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  workspaceDir = path.join(fixtureRoot, "workspace");
  workspacePngFile = path.join(workspaceDir, "chart.png");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(workspacePngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  stateDir = resolveStateDir();
  canvasPngFile = path.join(
    stateDir,
    "canvas",
    "documents",
    "cv_test",
    "collection.media",
    "tiny.png",
  );
  await fs.mkdir(path.dirname(canvasPngFile), { recursive: true });
  await fs.writeFile(canvasPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  if (stateDir) {
    await fs.rm(path.join(stateDir, "canvas", "documents", "cv_test"), {
      recursive: true,
      force: true,
    });
  }
});

describe("loadWebMedia", () => {
  function createLocalWebMediaOptions() {
    return {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
    };
  }

  async function expectRejectedWebMedia(
    url: string,
    expectedError: Record<string, unknown> | RegExp,
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined,
  ) {
    const restoreHandle = setup?.();
    try {
      if (expectedError instanceof RegExp) {
        await expect(loadWebMedia(url, createLocalWebMediaOptions())).rejects.toThrow(
          expectedError,
        );
        return;
      }
      await expect(loadWebMedia(url, createLocalWebMediaOptions())).rejects.toMatchObject(
        expectedError,
      );
    } finally {
      restoreHandle?.mockRestore?.();
      restoreHandle?.restore?.();
    }
  }

  async function expectRejectedWebMediaWithoutFilesystemAccess(params: {
    url: string;
    expectedError: Record<string, unknown> | RegExp;
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined;
  }) {
    const realpathSpy = vi.spyOn(fs, "realpath");
    try {
      await expectRejectedWebMedia(params.url, params.expectedError, params.setup);
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  }

  async function expectLoadedWebMediaCase(url: string) {
    const result = await loadWebMedia(url, createLocalWebMediaOptions());
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  }

  it.each([
    {
      name: "allows localhost file URLs for local files",
      createUrl: () => {
        const fileUrl = pathToFileURL(tinyPngFile);
        fileUrl.hostname = "localhost";
        return fileUrl.href;
      },
    },
  ] as const)("$name", async ({ createUrl }) => {
    await expectLoadedWebMediaCase(createUrl());
  });

  it.each([
    {
      name: "rejects remote-host file URLs before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: { code: "invalid-file-url" },
    },
    {
      name: "rejects remote-host file URLs with the explicit error message before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: /remote hosts are not allowed/i,
    },
    {
      name: "rejects Windows network paths before filesystem checks",
      url: "\\\\attacker\\share\\evil.png",
      expectedError: { code: "network-path-not-allowed" },
      setup: () => vi.spyOn(process, "platform", "get").mockReturnValue("win32"),
    },
  ] as const)("$name", async (testCase) => {
    await expectRejectedWebMediaWithoutFilesystemAccess(testCase);
  });

  it("loads browser-style canvas media paths as managed local files", async () => {
    const result = await loadWebMedia(
      `${CANVAS_HOST_PATH}/documents/cv_test/collection.media/tiny.png`,
      { maxBytes: 1024 * 1024 },
    );
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("resolves relative local media paths against the provided workspace directory", async () => {
    const result = await loadWebMedia("chart.png", {
      maxBytes: 1024 * 1024,
      localRoots: [workspaceDir],
      workspaceDir,
    });
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("rejects host-read text files outside local roots", async () => {
    const secretFile = path.join(fixtureRoot, "secret.txt");
    await fs.writeFile(secretFile, "secret", "utf8");
    await expect(
      loadWebMedia(secretFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("rejects renamed host-read text files even when the extension looks allowed", async () => {
    const disguisedPdf = path.join(fixtureRoot, "secret.pdf");
    await fs.writeFile(disguisedPdf, "secret", "utf8");
    await expect(
      loadWebMedia(disguisedPdf, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("rejects traversal-style canvas media paths before filesystem access", async () => {
    await expect(
      loadWebMedia(`${CANVAS_HOST_PATH}/documents/../collection.media/tiny.png`),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });
});
