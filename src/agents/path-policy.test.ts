// Verifies workspace-relative path policy across POSIX and Windows semantics.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const resolveSandboxInputPathMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox-paths.js", () => ({
  resolveSandboxInputPath: resolveSandboxInputPathMock,
}));

import { toRelativeWorkspacePath } from "./path-policy.js";

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
