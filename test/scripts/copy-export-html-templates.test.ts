// Export HTML template copy tests cover generated-output root safety.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyExportHtmlTemplates,
  generateExportHtmlVendorAssets,
} from "../../scripts/runtime-postbuild.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("copyExportHtmlTemplates", () => {
  it("builds deterministic self-contained browser globals from pinned dependencies", () => {
    const first = generateExportHtmlVendorAssets();
    const second = generateExportHtmlVendorAssets();
    expect(second).toEqual(first);
    expect(first["marked.min.js"]).toContain("Permission is hereby granted");
    expect(first["highlight.min.js"]).toContain("BSD 3-Clause License");

    const runtime: {
      marked?: { parse?: (markdown: string) => string };
      hljs?: {
        getLanguage?: (language: string) => unknown;
        highlight?: (source: string, options: { language: string }) => { value: string };
      };
    } = {};
    vm.createContext(runtime);
    vm.runInContext(first["marked.min.js"] ?? "", runtime);
    vm.runInContext(first["highlight.min.js"] ?? "", runtime);

    expect(runtime.marked?.parse?.("**safe**")).toContain("<strong>safe</strong>");
    expect(runtime.hljs?.getLanguage?.("typescript")).toBeDefined();
    expect(
      runtime.hljs?.highlight?.("const value = true;", { language: "typescript" }).value,
    ).toContain("hljs-keyword");
  });

  it("copies authored templates and generates vendor assets only in dist", () => {
    const projectRoot = tempDirs.make("openclaw-export-html-copy-");
    const sourceDir = path.join(projectRoot, "src", "auto-reply", "reply", "export-html");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "template.html"), "<html></html>\n");
    fs.symlinkSync(
      path.resolve("node_modules"),
      path.join(projectRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    copyExportHtmlTemplates({ rootDir: projectRoot });

    expect(
      fs.readFileSync(path.join(projectRoot, "dist", "export-html", "template.html"), "utf8"),
    ).toBe("<html></html>\n");
    expect(
      fs.readFileSync(
        path.join(projectRoot, "dist", "export-html", "vendor", "marked.min.js"),
        "utf8",
      ),
    ).toContain("var marked=");
    expect(
      fs.readFileSync(
        path.join(projectRoot, "dist", "export-html", "vendor", "highlight.min.js"),
        "utf8",
      ),
    ).toContain("var hljs=");
    expect(fs.existsSync(path.join(sourceDir, "vendor"))).toBe(false);
  });

  it("resolves relative caller roots without changing the process cwd", () => {
    const projectRoot = tempDirs.make("openclaw-export-html-relative-root-");
    const relativeRoot = path.relative(process.cwd(), projectRoot);
    const sourceDir = path.join(projectRoot, "src", "auto-reply", "reply", "export-html");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "template.html"), "<html></html>\n");
    fs.symlinkSync(
      path.resolve("node_modules"),
      path.join(projectRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    copyExportHtmlTemplates({ rootDir: relativeRoot });

    const vendorDir = path.join(projectRoot, "dist", "export-html", "vendor");
    expect(fs.readFileSync(path.join(vendorDir, "marked.min.js"), "utf8")).toContain(
      "Permission is hereby granted",
    );
    expect(fs.readFileSync(path.join(vendorDir, "highlight.min.js"), "utf8")).toContain(
      "BSD 3-Clause License",
    );
    expect(
      fs.readFileSync(path.join(projectRoot, "dist", "export-html", "template.html"), "utf8"),
    ).toBe("<html></html>\n");
  });

  it("rejects a symlinked dist root without changing its target", () => {
    const projectRoot = tempDirs.make("openclaw-export-html-output-root-");
    const sourceDir = path.join(projectRoot, "src", "auto-reply", "reply", "export-html");
    const targetDir = path.join(projectRoot, "live-gateway-dist");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "template.html"), "<html></html>\n");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "sentinel.js"), "keep\n");
    fs.symlinkSync(targetDir, path.join(projectRoot, "dist"), "dir");

    expect(() => copyExportHtmlTemplates({ rootDir: projectRoot })).toThrow(/symbolic link/u);
    expect(fs.readFileSync(path.join(targetDir, "sentinel.js"), "utf8")).toBe("keep\n");
    expect(fs.readlinkSync(path.join(projectRoot, "dist"))).toBe(targetDir);
  });
});
