// Core Canvas document storage and URL contract coverage.
import { link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createCanvasDocument,
  readCanvasDocumentHtmlSource,
  resolveCanvasDocumentsDir,
  resolveCanvasHttpPathToLocalPath,
} from "./documents.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resolveCanvasDocumentDir(stateDir: string, documentId: string): string {
  return path.join(resolveCanvasDocumentsDir(stateDir), documentId);
}

describe("canvas documents", () => {
  it.skipIf(process.platform === "win32").each(["document", "manifest.json", "index.html"])(
    "rejects a symlinked %s when reading widget HTML",
    async (target) => {
      const stateDir = tempDirs.make("openclaw-canvas-links-");
      const outsideDir = tempDirs.make("openclaw-canvas-outside-");
      const document = await createCanvasDocument(
        { kind: "html_bundle", entrypoint: { type: "html", value: "<p>outside</p>" } },
        { stateDir },
      );
      const documentDir = resolveCanvasDocumentDir(stateDir, document.id);
      const original = target === "document" ? documentDir : path.join(documentDir, target);
      const outside = path.join(outsideDir, target);
      await rename(original, outside);
      await symlink(outside, original, target === "document" ? "dir" : "file");

      await expect(readCanvasDocumentHtmlSource(document.id, { stateDir })).rejects.toMatchObject({
        code: target === "document" ? "outside-workspace" : "symlink",
      });
    },
  );

  it.each(["manifest.json", "index.html"])(
    "rejects a hardlinked %s when reading widget HTML",
    async (target) => {
      const stateDir = tempDirs.make("openclaw-canvas-hardlinks-");
      const document = await createCanvasDocument(
        { kind: "html_bundle", entrypoint: { type: "html", value: "<p>aliased</p>" } },
        { stateDir },
      );
      await link(
        path.join(resolveCanvasDocumentDir(stateDir, document.id), target),
        path.join(stateDir, `alias-${target}`),
      );
      await expect(readCanvasDocumentHtmlSource(document.id, { stateDir })).rejects.toMatchObject({
        code: "hardlink",
      });
    },
  );

  it("bounds HTML reads by bytes while independently allowing the manifest", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-bounded-");
    const document = await createCanvasDocument(
      { kind: "html_bundle", entrypoint: { type: "html", value: "éééé" } },
      { stateDir },
    );
    await expect(
      readCanvasDocumentHtmlSource(document.id, { stateDir, maxBytes: 7 }),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(
      readCanvasDocumentHtmlSource(document.id, { stateDir, maxBytes: 8 }),
    ).resolves.toEqual({ html: "éééé" });
  });

  it("rejects oversized manifests before parsing them", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-manifest-");
    const document = await createCanvasDocument(
      { kind: "html_bundle", entrypoint: { type: "html", value: "<p>small</p>" } },
      { stateDir },
    );
    const manifestPath = path.join(
      resolveCanvasDocumentDir(stateDir, document.id),
      "manifest.json",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({ ...document, title: "x".repeat(2 * 1024 * 1024) }),
    );
    await expect(readCanvasDocumentHtmlSource(document.id, { stateDir })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("builds entry urls for materialized path documents under managed storage", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const workspaceDir = tempDirs.make("openclaw-canvas-documents-workspace-");
    await mkdir(path.join(workspaceDir, "player"), { recursive: true });
    await writeFile(path.join(workspaceDir, "player/index.html"), "<div>ok</div>", "utf8");

    const document = await createCanvasDocument(
      {
        kind: "html_bundle",
        entrypoint: { type: "path", value: "player/index.html" },
      },
      { stateDir, workspaceDir },
    );

    expect(document.entryUrl).toContain("/__openclaw__/canvas/documents/");
    expect(document.localEntrypoint).toBe("index.html");
    expect(resolveCanvasDocumentDir(stateDir, document.id)).toContain(stateDir);
  });

  it("materializes inline html bundles as index documents", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const document = await createCanvasDocument(
      {
        kind: "html_bundle",
        title: "Preview",
        entrypoint: {
          type: "html",
          value:
            "<!doctype html><html><head><style>.demo{color:red}</style></head><body><div class='demo'>Front</div></body></html>",
        },
      },
      { stateDir },
    );

    const indexHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, document.id), "index.html"),
      "utf8",
    );
    expect(indexHtml).toContain("<div class='demo'>Front</div>");
    expect(indexHtml).toContain("<style>.demo{color:red}</style>");
    expect(document.title).toBe("Preview");
    expect(document.entryUrl).toBe(`/__openclaw__/canvas/documents/${document.id}/index.html`);
    await expect(readCanvasDocumentHtmlSource(document.id, { stateDir })).resolves.toEqual({
      html: indexHtml,
    });
  });

  it("reports the document sandbox policy alongside board source bytes", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const document = await createCanvasDocument(
      {
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<script>ready()</script>" },
        cspSandbox: "scripts",
      },
      { stateDir },
    );

    await expect(readCanvasDocumentHtmlSource(document.id, { stateDir })).resolves.toEqual({
      html: "<script>ready()</script>",
      cspSandbox: "scripts",
    });
  });

  it("reuses a supplied stable id by replacing the prior materialized view", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const first = await createCanvasDocument(
      {
        id: "status-card",
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<div>first</div>" },
      },
      { stateDir },
    );
    const second = await createCanvasDocument(
      {
        id: "status-card",
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<div>second</div>" },
      },
      { stateDir },
    );

    expect(first.id).toBe("status-card");
    expect(second.id).toBe("status-card");
    const indexHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, second.id), "index.html"),
      "utf8",
    );
    expect(indexHtml).toContain("second");
    expect(indexHtml).not.toContain("first");
  });

  it("copies declared assets into managed storage", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const workspaceDir = tempDirs.make("openclaw-canvas-documents-workspace-");
    await mkdir(path.join(workspaceDir, "collection.media"), { recursive: true });
    await writeFile(path.join(workspaceDir, "collection.media/audio.mp3"), "audio", "utf8");

    const document = await createCanvasDocument(
      {
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<audio></audio>" },
        assets: [
          {
            logicalPath: "collection.media/audio.mp3",
            sourcePath: "collection.media/audio.mp3",
            contentType: "audio/mpeg",
          },
        ],
      },
      { stateDir, workspaceDir },
    );

    expect(document.assets).toEqual([
      { logicalPath: "collection.media/audio.mp3", contentType: "audio/mpeg" },
    ]);
    await expect(
      readFile(
        path.join(resolveCanvasDocumentDir(stateDir, document.id), "collection.media/audio.mp3"),
        "utf8",
      ),
    ).resolves.toBe("audio");
  });

  it("wraps local and remote PDF documents in index viewer pages", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const workspaceDir = tempDirs.make("openclaw-canvas-documents-workspace-");
    await writeFile(path.join(workspaceDir, "demo.pdf"), "%PDF-1.4", "utf8");
    const localDocument = await createCanvasDocument(
      { kind: "document", entrypoint: { type: "path", value: "demo.pdf" } },
      { stateDir, workspaceDir },
    );
    const remoteDocument = await createCanvasDocument(
      {
        kind: "document",
        entrypoint: { type: "url", value: "https://example.com/demo.pdf" },
      },
      { stateDir },
    );

    const localHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, localDocument.id), "index.html"),
      "utf8",
    );
    const remoteHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, remoteDocument.id), "index.html"),
      "utf8",
    );
    expect(localHtml).toContain('data="demo.pdf"');
    expect(remoteHtml).toContain('data="https://example.com/demo.pdf"');
  });

  it("rejects traversal and malformed encoded hosted paths", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/../collection.media/index.html",
        { stateDir },
      ),
    ).toBeNull();

    const documentDir = resolveCanvasDocumentDir(stateDir, "cv_malformed");
    await mkdir(documentDir, { recursive: true });
    await writeFile(path.join(documentDir, "%E0%A4%A.html"), "literal-percent-name", "utf8");
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/cv_malformed/%E0%A4%A.html",
        { stateDir },
      ),
    ).toBeNull();
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/cv_malformed/%25E0%25A4%25A.html",
        { stateDir },
      ),
    ).toBe(path.join(documentDir, "%E0%A4%A.html"));
  });
});
