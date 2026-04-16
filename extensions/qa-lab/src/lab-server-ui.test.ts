import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectContentType,
  missingUiHtml,
  resolveUiAssetVersion,
  tryResolveUiAsset,
} from "./lab-server-ui.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa-lab server ui helpers", () => {
  it("detects basic UI asset content types", () => {
    expect(detectContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(detectContentType("styles.css")).toBe("text/css; charset=utf-8");
    expect(detectContentType("main.js")).toBe("text/javascript; charset=utf-8");
    expect(detectContentType("icon.svg")).toBe("image/svg+xml");
  });

  it("renders the missing-ui placeholder html", () => {
    expect(missingUiHtml()).toContain("QA Lab UI not built");
    expect(missingUiHtml()).toContain("pnpm qa:lab:build");
  });

  it("hashes built UI assets and changes when bundle contents change", async () => {
    const uiDistDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-dist-"));
    cleanups.push(async () => {
      await rm(uiDistDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const version1 = resolveUiAssetVersion(uiDistDir);
    expect(version1).toMatch(/^[0-9a-f]{12}$/);

    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab Updated</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const version2 = resolveUiAssetVersion(uiDistDir);
    expect(version2).toMatch(/^[0-9a-f]{12}$/);
    expect(version2).not.toBe(version1);
  });

  it("never resolves sibling files outside the UI dist root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-boundary-"));
    cleanups.push(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });
    const uiDistDir = path.join(rootDir, "dist");
    const siblingDir = path.join(rootDir, "dist-other");
    await mkdir(uiDistDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><body>bundle-root</body></html>",
      "utf8",
    );
    await writeFile(path.join(siblingDir, "secret.txt"), "sibling-secret", "utf8");

    expect(tryResolveUiAsset("/", uiDistDir, rootDir)).toBe(path.join(uiDistDir, "index.html"));
    expect(tryResolveUiAsset("/../dist-other/secret.txt", uiDistDir, rootDir)).toBeNull();
  });

  it("rejects malformed percent-encoded UI asset paths", async () => {
    const uiDistDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-malformed-"));
    cleanups.push(async () => {
      await rm(uiDistDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><body>bundle-root</body></html>",
      "utf8",
    );

    expect(tryResolveUiAsset("/%E0%A4", uiDistDir, uiDistDir)).toBeNull();
  });
});
