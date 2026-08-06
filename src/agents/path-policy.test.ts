// Verifies workspace-relative path policy across POSIX and Windows semantics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const resolveSandboxInputPathMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox-paths.js", () => ({
  resolveSandboxInputPath: resolveSandboxInputPathMock,
}));

import { preserveAtPrefixedRelativePath, toRelativeWorkspacePath } from "./path-policy.js";

describe("toRelativeWorkspacePath (windows semantics)", () => {
  beforeEach(() => {
    // Sandbox input resolution is not under test; return normalized input paths directly.
    resolveSandboxInputPathMock.mockReset();
    resolveSandboxInputPathMock.mockImplementation((filePath: string) => filePath);
  });

  it("accepts windows paths with mixed separators and case", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "c:/users/user/openclaw/memory/log.txt";
      expect(toRelativeWorkspacePath(root, candidate)).toBe("memory\\log.txt");
    });
  });

  it("preserves filename case so callers create the file the agent asked for", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "C:\\Users\\User\\OpenClaw\\src\\Components\\MyComponent.tsx";
      expect(toRelativeWorkspacePath(root, candidate)).toBe("src\\Components\\MyComponent.tsx");
    });
  });

  it("preserves candidate case when the root itself is spelled with different case", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "c:/users/user/openclaw/Memory/Log.txt";
      expect(toRelativeWorkspacePath(root, candidate)).toBe("Memory\\Log.txt");
    });
  });

  it("accepts extended-length prefixed windows paths", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "\\\\?\\C:\\Users\\User\\OpenClaw\\Memory\\Log.txt";
      expect(toRelativeWorkspacePath(root, candidate)).toBe("Memory\\Log.txt");
    });
  });

  it("rejects windows paths outside workspace root", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "C:\\Users\\User\\Other\\log.txt";
      expect(() => toRelativeWorkspacePath(root, candidate)).toThrow("Path escapes workspace root");
    });
  });

  it("rejects windows escapes that differ from the root only by case", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "c:\\users\\USER\\openclaw\\..\\Other\\log.txt";
      expect(() => toRelativeWorkspacePath(root, candidate)).toThrow("Path escapes workspace root");
    });
  });

  it("treats a differently-cased root as the root itself", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "c:\\users\\USER\\openclaw";
      expect(toRelativeWorkspacePath(root, candidate, { allowRoot: true })).toBe("");
    });
  });
});

describe("preserveAtPrefixedRelativePath", () => {
  it.each([
    // Mention shorthand: the strip is what resolves these, and 9ef0fc2ff8f relies
    // on it to route @-prefixed absolutes through the workspace guard.
    "@/etc/passwd",
    "@/workspace/docs/readme.md",
    "@~/notes.md",
    "@~",
    "@file:///tmp/notes.md",
    "@",
    // Relative, no literal on disk: the TUI autocomplete emits this form.
    "@src/foo.ts",
    "notes.md",
  ])("leaves %s alone when no literal file exists", (input) => {
    expect(preserveAtPrefixedRelativePath(input, "/workspace/root")).toBe(input);
  });

  it("marks a relative @path explicitly relative once that literal file exists", async () => {
    const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-at-policy-")));
    try {
      await fs.writeFile(path.join(cwd, "@notes.md"), "literal\n");
      expect(preserveAtPrefixedRelativePath("@notes.md", cwd)).toBe("./@notes.md");
      // An absolute mention shorthand keeps stripping even with a literal present.
      expect(preserveAtPrefixedRelativePath("@/etc/passwd", cwd)).toBe("@/etc/passwd");
      // "~" only expands as "~" or "~/", so "@~notes.md" is an ordinary filename.
      await fs.writeFile(path.join(cwd, "@~notes.md"), "tilde\n");
      expect(preserveAtPrefixedRelativePath("@~notes.md", cwd)).toBe("./@~notes.md");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("toRelativeWorkspacePath", () => {
  it("accepts dot-dot-prefixed filenames inside the workspace", () => {
    expect(toRelativeWorkspacePath("/workspace/root", "/workspace/root/..file.txt")).toBe(
      "..file.txt",
    );
  });

  it("rejects parent directory traversal outside the workspace", () => {
    expect(() => toRelativeWorkspacePath("/workspace/root", "/workspace/root/../file.txt")).toThrow(
      "Path escapes workspace root",
    );
  });
});
