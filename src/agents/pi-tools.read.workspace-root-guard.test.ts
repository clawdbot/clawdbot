import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";

type AssertSandboxPath = typeof import("./sandbox-paths.js").assertSandboxPath;

const mocks = vi.hoisted(() => ({
  assertSandboxPath: vi.fn<AssertSandboxPath>(async () => ({
    resolved: "/tmp/root",
    relative: "",
  })),
}));

vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: mocks.assertSandboxPath,
}));

function createToolHarness() {
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const tool = {
    name: "read",
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    execute,
  } as unknown as AnyAgentTool;
  return { execute, tool };
}

async function loadModule() {
  ({ wrapToolWorkspaceRootGuardWithOptions } = await import("./pi-tools.read.js"));
}

let wrapToolWorkspaceRootGuardWithOptions: typeof import("./pi-tools.read.js").wrapToolWorkspaceRootGuardWithOptions;

describe("wrapToolWorkspaceRootGuardWithOptions", () => {
  const root = "/tmp/root";
  const assertSandboxPathImpl: AssertSandboxPath = async ({ filePath }) => ({
    resolved:
      filePath.startsWith("file://") || path.isAbsolute(filePath)
        ? filePath
        : path.resolve(root, filePath),
    relative: "",
  });

  beforeAll(loadModule);

  beforeEach(() => {
    mocks.assertSandboxPath.mockReset();
    mocks.assertSandboxPath.mockImplementation(assertSandboxPathImpl);
  });

  it("maps container workspace paths to host workspace root", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc1", { path: "/workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: path.resolve(root, "docs", "readme.md"),
      cwd: root,
      root,
    });
  });

  it("maps file:// container workspace paths to host workspace root", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc2", { path: "file:///workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: path.resolve(root, "docs", "readme.md"),
      cwd: root,
      root,
    });
  });

  it("does not remap remote-host file:// paths", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-remote-file-url", { path: "file://attacker/share/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "file://attacker/share/readme.md",
      cwd: root,
      root,
    });
  });

  it("does not remap malformed file:// container workspace paths", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-malformed-file-url", { path: "file:///workspace/%E0%A4%A" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "file:///workspace/%E0%A4%A",
      cwd: root,
      root,
    });
  });

  it("does not remap file:// container workspace paths with encoded separators", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-encoded-separator-file-url", {
      path: "file:///workspace/%2FREADME.md",
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "file:///workspace/%2FREADME.md",
      cwd: root,
      root,
    });
  });

  it("maps @-prefixed container workspace paths to host workspace root", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-at-container", { path: "@/workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: path.resolve(root, "docs", "readme.md"),
      cwd: root,
      root,
    });
  });

  it("normalizes @-prefixed absolute paths before guard checks", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-at-absolute", { path: "@/etc/passwd" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "/etc/passwd",
      cwd: root,
      root,
    });
  });

  it("does not remap absolute paths outside the configured container workdir", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc3", { path: "/workspace-two/secret.txt" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "/workspace-two/secret.txt",
      cwd: root,
      root,
    });
  });

  it("does not guard outPath by default", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-outpath-default", { outPath: "/workspace/videos/capture.mp4" });

    expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
  });

  it("guards custom outPath params when configured", async () => {
    const { execute, tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
      pathParamKeys: ["outPath"],
      normalizeGuardedPathParams: true,
    });

    await wrapped.execute("tc-outpath-custom", { outPath: "videos/capture.mp4" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "videos/capture.mp4",
      cwd: root,
      root,
    });
    expect(execute).toHaveBeenCalledWith(
      "tc-outpath-custom",
      { outPath: path.resolve(root, "videos", "capture.mp4") },
      undefined,
      undefined,
    );
  });
});
