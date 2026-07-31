// Export HTML template copy tests cover generated-output root safety.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyExportHtmlTemplates } from "../../scripts/copy-export-html-templates.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("copyExportHtmlTemplates", () => {
  it("rejects a symlinked dist root without changing its target", () => {
    const projectRoot = tempDirs.make("openclaw-export-html-output-root-");
    const sourceDir = path.join(projectRoot, "src", "auto-reply", "reply", "export-html");
    const targetDir = path.join(projectRoot, "live-gateway-dist");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "template.html"), "<html></html>\n");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "sentinel.js"), "keep\n");
    fs.symlinkSync(targetDir, path.join(projectRoot, "dist"), "dir");

    expect(() => copyExportHtmlTemplates({ projectRoot })).toThrow(/symbolic link/u);
    expect(fs.readFileSync(path.join(targetDir, "sentinel.js"), "utf8")).toBe("keep\n");
    expect(fs.readlinkSync(path.join(projectRoot, "dist"))).toBe(targetDir);
  });
});
