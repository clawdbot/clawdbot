import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      access: fsMocks.access,
      realpath: fsMocks.realpath,
    },
    access: fsMocks.access,
    realpath: fsMocks.realpath,
  };
});

import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveStableNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
  vi.resetAllMocks();
});

function mockNodeRealpath(realpaths: Record<string, string> = {}) {
  fsMocks.realpath.mockImplementation(async (target: string) => realpaths[target] ?? target);
}

function mockNodePathPresent(...nodePaths: string[]) {
  mockNodeRealpath();
  fsMocks.access.mockImplementation(async (target: string) => {
    if (nodePaths.includes(target)) {
      return;
    }
    throw new Error("missing");
  });
}

describe("resolvePreferredNodePath", () => {
  const darwinNode = "/opt/homebrew/bin/node";
  const fnmNode = "/Users/test/.fnm/node-versions/v24.11.1/installation/bin/node";
  const linuxSystemNode = "/usr/bin/node";
  const nvmNode = "/home/test/.nvm/versions/node/v24.14.1/bin/node";

  it("prefers supported system node over version-manager execPath", async () => {
    mockNodePathPresent(darwinNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "24.11.1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "24.11.1\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: fnmNode,
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("uses system node for Linux service installs instead of nvm execPath", async () => {
    mockNodePathPresent(linuxSystemNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "24.14.1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "24.14.1\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "linux",
      execFile,
      execPath: nvmNode,
    });

    expect(result).toBe(linuxSystemNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("uses system node for Linux service installs instead of default fnm execPath", async () => {
    const linuxFnmNode = "/home/test/.local/share/fnm/aliases/default/bin/node";
    mockNodePathPresent(linuxSystemNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "24.14.1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "24.14.1\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "linux",
      execFile,
      execPath: linuxFnmNode,
    });

    expect(result).toBe(linuxSystemNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("uses system node for macOS service installs instead of default fnm execPath", async () => {
    const darwinFnmNode = "/Users/test/Library/Application Support/fnm/aliases/default/bin/node";
    mockNodePathPresent(darwinNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "24.14.1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "24.14.1\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: darwinFnmNode,
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("uses Homebrew opt Node when a version-manager execPath is active", async () => {
    const homebrewOptNode = "/opt/homebrew/opt/node@22/bin/node";
    mockNodePathPresent(homebrewOptNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "24.11.1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "22.17.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: fnmNode,
    });

    expect(result).toBe(homebrewOptNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to version-manager execPath when no supported system node exists", async () => {
    mockNodePathPresent(darwinNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "24.11.1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "18.0.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: fnmNode,
    });

    expect(result).toBe(fnmNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to system node when execPath version is unsupported", async () => {
    mockNodePathPresent(darwinNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "18.0.0\n", stderr: "" }) // execPath too old
      .mockResolvedValueOnce({ stdout: "22.16.0\n", stderr: "" }); // system node ok

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "/some/old/node",
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("ignores execPath when it is not node", async () => {
    mockNodePathPresent(darwinNode);

    const execFile = vi.fn().mockResolvedValue({ stdout: "22.16.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "/Users/test/.bun/bin/bun",
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(darwinNode, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
  });

  it("uses system node when it meets the minimum version", async () => {
    mockNodePathPresent(darwinNode);

    // Node 22.16.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.16.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: darwinNode,
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("skips system node when it is too old", async () => {
    mockNodePathPresent(darwinNode);

    // Node 22.15.x is below minimum 22.16.0
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.15.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "",
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when no system node is found", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const execFile = vi.fn().mockRejectedValue(new Error("not found"));

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "",
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveStableNodePath", () => {
  it("resolves Homebrew Cellar path to opt symlink", async () => {
    mockNodePathPresent("/opt/homebrew/opt/node/bin/node");

    const result = await resolveStableNodePath("/opt/homebrew/Cellar/node/25.7.0/bin/node");
    expect(result).toBe("/opt/homebrew/opt/node/bin/node");
  });

  it("falls back to bin symlink for default node formula", async () => {
    mockNodePathPresent("/opt/homebrew/bin/node");

    const result = await resolveStableNodePath("/opt/homebrew/Cellar/node/25.7.0/bin/node");
    expect(result).toBe("/opt/homebrew/bin/node");
  });

  it("resolves Intel Mac Cellar path to opt symlink", async () => {
    mockNodePathPresent("/usr/local/opt/node/bin/node");

    const result = await resolveStableNodePath("/usr/local/Cellar/node/25.7.0/bin/node");
    expect(result).toBe("/usr/local/opt/node/bin/node");
  });

  it("resolves versioned node@22 formula to opt symlink", async () => {
    mockNodePathPresent("/opt/homebrew/opt/node@22/bin/node");

    const result = await resolveStableNodePath("/opt/homebrew/Cellar/node@22/22.16.0/bin/node");
    expect(result).toBe("/opt/homebrew/opt/node@22/bin/node");
  });

  it("returns original path when no stable symlink exists", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const cellarPath = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const result = await resolveStableNodePath(cellarPath);
    expect(result).toBe(cellarPath);
  });

  it("returns non-Cellar paths unchanged", async () => {
    const fnmPath = "/Users/test/.fnm/node-versions/v24.11.1/installation/bin/node";
    const result = await resolveStableNodePath(fnmPath);
    expect(result).toBe(fnmPath);
  });

  it("returns system paths unchanged", async () => {
    const result = await resolveStableNodePath("/opt/homebrew/bin/node");
    expect(result).toBe("/opt/homebrew/bin/node");
  });
});

describe("resolvePreferredNodePath — Homebrew Cellar", () => {
  it("resolves Cellar execPath to stable Homebrew symlink", async () => {
    const cellarNode = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const stableNode = "/opt/homebrew/opt/node/bin/node";
    mockNodePathPresent(stableNode);

    const execFile = vi.fn().mockResolvedValue({ stdout: "25.7.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: cellarNode,
    });

    expect(result).toBe(stableNode);
  });
});

describe("resolveSystemNodeInfo", () => {
  const darwinNode = "/opt/homebrew/bin/node";

  it("returns supported info when version is new enough", async () => {
    mockNodePathPresent(darwinNode);

    // Node 22.16.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.16.0\n", stderr: "" });

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile,
    });

    expect(result).toEqual({
      path: darwinNode,
      version: "22.16.0",
      supported: true,
    });
  });

  it("returns undefined when system node is missing", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));
    const execFile = vi.fn();
    const result = await resolveSystemNodeInfo({ env: {}, platform: "darwin", execFile });
    expect(result).toBeNull();
  });

  it("continues past an old system node to find a supported candidate", async () => {
    const homebrewOptNode = "/opt/homebrew/opt/node@22/bin/node";
    mockNodePathPresent(darwinNode, homebrewOptNode);

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "18.0.0\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "22.17.0\n", stderr: "" });

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile,
    });

    expect(result).toEqual({
      path: homebrewOptNode,
      version: "22.17.0",
      supported: true,
    });
  });

  it("skips system-node candidates that resolve into version-manager paths", async () => {
    const homebrewOptNode = "/opt/homebrew/opt/node@22/bin/node";
    mockNodePathPresent(darwinNode, homebrewOptNode);
    mockNodeRealpath({
      [darwinNode]: "/Users/test/.nvm/versions/node/v24.14.1/bin/node",
      [homebrewOptNode]: homebrewOptNode,
    });

    const execFile = vi.fn().mockResolvedValue({ stdout: "24.14.1\n", stderr: "" });

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile,
    });

    expect(result).toEqual({
      path: homebrewOptNode,
      version: "24.14.1",
      supported: true,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(homebrewOptNode, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
  });

  it("returns null when every system-node candidate resolves into a version manager", async () => {
    mockNodePathPresent(darwinNode);
    mockNodeRealpath({
      [darwinNode]: "/Users/test/Library/Application Support/fnm/aliases/default/bin/node",
    });

    const execFile = vi.fn();

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile,
    });

    expect(result).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("renders a warning when system node is too old", () => {
    const warning = renderSystemNodeWarning(
      {
        path: darwinNode,
        version: "18.19.0",
        supported: false,
      },
      "/Users/me/.fnm/node-22/bin/node",
    );

    expect(warning).toContain("below the required Node 22.16+");
    expect(warning).toContain(darwinNode);
  });

  it("uses validated custom Program Files roots on Windows", async () => {
    const customNode = "D:\\Programs\\nodejs\\node.exe";
    mockNodePathPresent(customNode);

    const execFile = vi.fn().mockResolvedValue({ stdout: "24.11.1\n", stderr: "" });
    const result = await resolveSystemNodeInfo({
      env: {
        ProgramFiles: "D:\\Programs",
        "ProgramFiles(x86)": "E:\\Programs (x86)",
      },
      platform: "win32",
      execFile,
    });

    expect(result?.path).toBe(customNode);
  });

  it("prefers ProgramW6432 over ProgramFiles on Windows", async () => {
    const preferredNode = "D:\\Programs\\nodejs\\node.exe";
    const x86Node = "E:\\Programs (x86)\\nodejs\\node.exe";
    mockNodePathPresent(preferredNode, x86Node);

    const execFile = vi.fn().mockResolvedValue({ stdout: "24.11.1\n", stderr: "" });
    const result = await resolveSystemNodeInfo({
      env: {
        ProgramFiles: "E:\\Programs (x86)",
        "ProgramFiles(x86)": "E:\\Programs (x86)",
        ProgramW6432: "D:\\Programs",
      },
      platform: "win32",
      execFile,
    });

    expect(result?.path).toBe(preferredNode);
  });
});
