import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { loadHookEntriesFromDir, loadWorkspaceHookEntries } from "./workspace.js";

function writeHookPackageManifest(pkgDir: string, hooks: string[]): void {
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "pkg",
        [MANIFEST_KEY]: {
          hooks,
        },
      },
      null,
      2,
    ),
  );
}

function setupHardlinkHookWorkspace(hookName: string): {
  hooksRoot: string;
  hookDir: string;
  outsideDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-hardlink-"));
  const hooksRoot = path.join(root, "hooks");
  fs.mkdirSync(hooksRoot, { recursive: true });

  const hookDir = path.join(hooksRoot, hookName);
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  return { hooksRoot, hookDir, outsideDir };
}

function tryCreateHardlinkOrSkip(createLink: () => void): boolean {
  try {
    createLink();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      return false;
    }
    throw err;
  }
}

function hookNames(entries: ReturnType<typeof loadHookEntriesFromDir>): string[] {
  return entries.map((entry) => entry.hook.name);
}

describe("hooks workspace", () => {
  it("ignores package.json hook paths that traverse outside package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    const outsideHookDir = path.join(root, "outside");
    fs.mkdirSync(outsideHookDir, { recursive: true });
    fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideHookDir, "handler.js"), "export default async () => {};\n");

    writeHookPackageManifest(pkgDir, ["../outside"]);

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(hookNames(entries)).not.toContain("outside");
  });

  it("accepts package.json hook paths within package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-ok-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const nested = path.join(pkgDir, "nested");
    fs.mkdirSync(nested, { recursive: true });

    fs.writeFileSync(path.join(nested, "HOOK.md"), "---\nname: nested\n---\n");
    fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");

    writeHookPackageManifest(pkgDir, ["./nested"]);

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(hookNames(entries)).toContain("nested");
  });

  it("ignores package.json hook paths that escape via symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-link-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const outsideDir = path.join(root, "outside");
    const linkedDir = path.join(pkgDir, "linked");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideDir, "handler.js"), "export default async () => {};\n");
    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    writeHookPackageManifest(pkgDir, ["./linked"]);

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(hookNames(entries)).not.toContain("outside");
  });

  it("ignores hooks with hardlinked HOOK.md aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const { hooksRoot, hookDir, outsideDir } = setupHardlinkHookWorkspace("hardlink-hook");
    fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");
    const outsideHookMd = path.join(outsideDir, "HOOK.md");
    const linkedHookMd = path.join(hookDir, "HOOK.md");
    fs.writeFileSync(linkedHookMd, "---\nname: hardlink-hook\n---\n");
    fs.rmSync(linkedHookMd);
    fs.writeFileSync(outsideHookMd, "---\nname: outside\n---\n");
    if (!tryCreateHardlinkOrSkip(() => fs.linkSync(outsideHookMd, linkedHookMd))) {
      return;
    }

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    const names = hookNames(entries);
    expect(names).not.toContain("hardlink-hook");
    expect(names).not.toContain("outside");
  });

  it("ignores hooks with hardlinked handler aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const { hooksRoot, hookDir, outsideDir } = setupHardlinkHookWorkspace("hardlink-handler-hook");
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: hardlink-handler-hook\n---\n");
    const outsideHandler = path.join(outsideDir, "handler.js");
    const linkedHandler = path.join(hookDir, "handler.js");
    fs.writeFileSync(outsideHandler, "export default async () => {};\n");
    if (!tryCreateHardlinkOrSkip(() => fs.linkSync(outsideHandler, linkedHandler))) {
      return;
    }

    const entries = loadHookEntriesFromDir({ dir: hooksRoot, source: "openclaw-workspace" });
    expect(hookNames(entries)).not.toContain("hardlink-handler-hook");
  });

  it("does not let workspace hooks override managed hooks with the same name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-collision-"));
    const workspaceDir = path.join(root, "workspace");
    const managedHooksDir = path.join(root, "managed-hooks");
    const workspaceHookDir = path.join(workspaceDir, "hooks", "session-memory");
    const managedHookDir = path.join(managedHooksDir, "session-memory");
    fs.mkdirSync(workspaceHookDir, { recursive: true });
    fs.mkdirSync(managedHookDir, { recursive: true });

    for (const dir of [workspaceHookDir, managedHookDir]) {
      fs.writeFileSync(
        path.join(dir, "HOOK.md"),
        [
          "---",
          "name: session-memory",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "handler.js"), "export default async () => {};\n");
    }

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      managedHooksDir,
      bundledHooksDir: path.join(root, "bundled-none"),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.source).toBe("openclaw-managed");
  });

  it("treats configured extraDirs as managed hook sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-extra-"));
    const workspaceDir = path.join(root, "workspace");
    const extraHookDir = path.join(root, "shared-hooks", "shared-hook");
    fs.mkdirSync(extraHookDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraHookDir, "HOOK.md"),
      ["---", "name: shared-hook", 'metadata: {"openclaw":{"events":["command:new"]}}', "---"].join(
        "\n",
      ),
    );
    fs.writeFileSync(path.join(extraHookDir, "handler.js"), "export default async () => {};\n");

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      bundledHooksDir: path.join(root, "bundled-none"),
      config: {
        hooks: {
          internal: {
            enabled: true,
            load: {
              extraDirs: [path.join(root, "shared-hooks")],
            },
          },
        },
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.name).toBe("shared-hook");
    expect(entries[0]?.hook.source).toBe("openclaw-managed");
  });
});
