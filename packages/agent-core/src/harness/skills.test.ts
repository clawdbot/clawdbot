// Agent Core skills tests cover loader and prompt formatter behavior.
import { describe, expect, it } from "vitest";
import { loadSkills } from "./skills.js";
import { formatSkillsForSystemPrompt } from "./system-prompt.js";
import { FileError, ok, type ExecutionEnv, type FileInfo, type Result } from "./types.js";

function fileInfo(path: string, kind: FileInfo["kind"]): FileInfo {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind,
    size: 0,
    mtimeMs: 0,
  };
}

function missing(path: string): Result<never, FileError> {
  return { ok: false, error: new FileError("not_found", "not found", path) };
}

function createEnv(skillBody: string): ExecutionEnv {
  const skillFile = "/skills/demo/SKILL.md";
  const files = new Map([
    [
      skillFile,
      `---
name: demo
description: Demo skill
---

${skillBody}
`,
    ],
  ]);
  const directories = new Map<string, FileInfo[]>([
    ["/skills", [fileInfo("/skills/demo", "directory")]],
    ["/skills/demo", [fileInfo(skillFile, "file")]],
  ]);

  return {
    cwd: "/",
    absolutePath: async (path) => ok(path.startsWith("/") ? path : `/${path}`),
    joinPath: async (parts) => ok(parts.join("/").replaceAll(/\/+/g, "/")),
    readTextFile: async (path) => (files.has(path) ? ok(files.get(path) ?? "") : missing(path)),
    readTextLines: async (path) =>
      files.has(path) ? ok((files.get(path) ?? "").split(/\r?\n/)) : missing(path),
    readBinaryFile: async (path) =>
      files.has(path) ? ok(new TextEncoder().encode(files.get(path) ?? "")) : missing(path),
    writeFile: async () => ok(undefined),
    appendFile: async () => ok(undefined),
    fileInfo: async (path) => {
      if (files.has(path)) {
        return ok(fileInfo(path, "file"));
      }
      if (directories.has(path)) {
        return ok(fileInfo(path, "directory"));
      }
      return missing(path);
    },
    listDir: async (path) =>
      directories.has(path) ? ok(directories.get(path) ?? []) : missing(path),
    canonicalPath: async (path) => ok(path),
    exists: async (path) => ok(files.has(path) || directories.has(path)),
    createDir: async () => ok(undefined),
    remove: async () => ok(undefined),
    createTempDir: async () => ok("/tmp"),
    createTempFile: async () => ok("/tmp/file"),
    cleanup: async () => undefined,
    exec: async () => ok({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

describe("loadSkills", () => {
  it("sets a prompt version that changes when SKILL.md content changes", async () => {
    const before = await loadSkills(createEnv("# Demo\nfirst body\n"), "/skills");
    const after = await loadSkills(createEnv("# Demo\nsecond body\n"), "/skills");

    const beforeVersion = before.skills[0]?.promptVersion;
    expect(beforeVersion).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(after.skills[0]?.promptVersion).not.toBe(beforeVersion);
    expect(formatSkillsForSystemPrompt(before.skills)).toContain(
      `<version>${beforeVersion}</version>`,
    );
  });
});
