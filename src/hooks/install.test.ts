import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `moltbot-hook-install-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("installHooksFromArchive", () => {
  it("installs hook packs from zip archives", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.zip");

    const zip = new JSZip();
    zip.file(
      "package/package.json",
      JSON.stringify({
        name: "@moltbot/zip-hooks",
        version: "0.0.1",
        moltbot: { hooks: ["./hooks/zip-hook"] },
      }),
    );
    zip.file(
      "package/hooks/zip-hook/HOOK.md",
      [
        "---",
        "name: zip-hook",
        "description: Zip hook",
        'metadata: {"moltbot":{"events":["command:new"]}}',
        "---",
        "",
        "# Zip Hook",
      ].join("\n"),
    );
    zip.file("package/hooks/zip-hook/handler.ts", "export default async () => {};\n");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(archivePath, buffer);

    const hooksDir = path.join(stateDir, "hooks");
    const { installHooksFromArchive } = await import("./install.js");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hookPackId).toBe("zip-hooks");
    expect(result.hooks).toContain("zip-hook");
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "zip-hooks"));
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "zip-hook", "HOOK.md"))).toBe(true);
  });

  it("installs hook packs from tar archives", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    const pkgDir = path.join(workDir, "package");

    fs.mkdirSync(path.join(pkgDir, "hooks", "tar-hook"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@moltbot/tar-hooks",
        version: "0.0.1",
        moltbot: { hooks: ["./hooks/tar-hook"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "tar-hook", "HOOK.md"),
      [
        "---",
        "name: tar-hook",
        "description: Tar hook",
        'metadata: {"moltbot":{"events":["command:new"]}}',
        "---",
        "",
        "# Tar Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "tar-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );
    await tar.c({ cwd: workDir, file: archivePath }, ["package"]);

    const hooksDir = path.join(stateDir, "hooks");
    const { installHooksFromArchive } = await import("./install.js");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hookPackId).toBe("tar-hooks");
    expect(result.hooks).toContain("tar-hook");
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "tar-hooks"));
  });
});

describe("installHooksFromPath", () => {
  it("installs a single hook directory", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        "name: my-hook",
        "description: My hook",
        'metadata: {"moltbot":{"events":["command:new"]}}',
        "---",
        "",
        "# My Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");

    const hooksDir = path.join(stateDir, "hooks");
    const { installHooksFromPath } = await import("./install.js");
    const result = await installHooksFromPath({ path: hookDir, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hookPackId).toBe("my-hook");
    expect(result.hooks).toEqual(["my-hook"]);
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "my-hook"));
    expect(fs.existsSync(path.join(result.targetDir, "HOOK.md"))).toBe(true);
  });
});
