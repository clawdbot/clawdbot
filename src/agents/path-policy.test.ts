import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const resolveSandboxInputPathMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox-paths.js", () => ({
  resolveSandboxInputPath: resolveSandboxInputPathMock,
}));

import { toRelativeWorkspacePath } from "./path-policy.js";

describe("toRelativeWorkspacePath (windows semantics)", () => {
  beforeEach(() => {
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

  it("rejects windows paths outside workspace root", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "C:\\Users\\User\\Other\\log.txt";
      expect(() => toRelativeWorkspacePath(root, candidate)).toThrow("Path escapes workspace root");
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
