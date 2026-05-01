import { describe, expect, it, vi, beforeEach } from "vitest";

const runCommandWithTimeoutMock = vi.fn();
const installPluginFromDirMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./install.js", async () => {
  const actual = await vi.importActual<typeof import("./install.js")>("./install.js");
  return {
    ...actual,
    installPluginFromDir: (...args: unknown[]) => installPluginFromDirMock(...args),
  };
});

vi.resetModules();

const { installPluginFromGitSpec, parseGitPluginSpec } = await import("./git-install.js");

describe("parseGitPluginSpec", () => {
  it("normalizes GitHub shorthand and ref selectors", () => {
    expect(parseGitPluginSpec("git:github.com/acme/demo@v1.2.3")).toMatchObject({
      url: "https://github.com/acme/demo.git",
      ref: "v1.2.3",
      label: "acme/demo",
      normalizedSpec: "git:https://github.com/acme/demo.git@v1.2.3",
    });
    expect(parseGitPluginSpec("git:acme/demo#main")).toMatchObject({
      url: "https://github.com/acme/demo.git",
      ref: "main",
    });
  });

  it("keeps scp-style clone URLs without treating git@ as a ref", () => {
    expect(parseGitPluginSpec("git:git@github.com:acme/demo.git@release")).toMatchObject({
      url: "git@github.com:acme/demo.git",
      ref: "release",
      label: "git@github.com:acme/demo.git",
    });
  });
});

describe("installPluginFromGitSpec", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    installPluginFromDirMock.mockReset();
  });

  it("clones, checks out refs, installs from the clone, and returns commit metadata", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" });
    installPluginFromDirMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.2.3",
      extensions: ["index.js"],
    });

    const result = await installPluginFromGitSpec({
      spec: "git:github.com/acme/demo@v1.2.3",
      expectedPluginId: "demo",
    });

    expect(result).toMatchObject({
      ok: true,
      pluginId: "demo",
      git: {
        url: "https://github.com/acme/demo.git",
        ref: "v1.2.3",
        commit: "abc123",
      },
    });
    expect(runCommandWithTimeoutMock.mock.calls[0][0]).toEqual([
      "git",
      "clone",
      "https://github.com/acme/demo.git",
      expect.stringContaining("/repo"),
    ]);
    expect(runCommandWithTimeoutMock.mock.calls[1][0]).toEqual([
      "git",
      "checkout",
      "--detach",
      "v1.2.3",
    ]);
    expect(installPluginFromDirMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPluginId: "demo",
        installPolicyRequest: {
          kind: "plugin-git",
          requestedSpecifier: "git:github.com/acme/demo@v1.2.3",
        },
      }),
    );
  });

  it("uses a shallow clone when no ref is requested", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" });
    installPluginFromDirMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.2.3",
      extensions: ["index.js"],
    });

    await installPluginFromGitSpec({ spec: "git:github.com/acme/demo" });

    expect(runCommandWithTimeoutMock.mock.calls[0][0]).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "https://github.com/acme/demo.git",
      expect.stringContaining("/repo"),
    ]);
  });
});
