// Tests operating system summary collection and normalization.
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

import { resolveOsSummary, resolveRuntimeOsLabel } from "./os-summary.js";

type OsSummaryCase = {
  name: string;
  platform: ReturnType<typeof os.platform>;
  release: string;
  arch: ReturnType<typeof os.arch>;
  swVersStdout?: string;
  expected: ReturnType<typeof resolveOsSummary>;
};

describe("resolveOsSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  it.each<OsSummaryCase>([
    {
      name: "formats darwin labels from sw_vers output",
      platform: "darwin" as const,
      release: "24.0.0",
      arch: "arm64",
      swVersStdout: " 15.4 \n",
      expected: {
        platform: "darwin",
        arch: "arm64",
        release: "24.0.0",
        label: "macos 15.4 (arm64)",
      },
    },
    {
      name: "falls back to os.release when sw_vers output is blank",
      platform: "darwin" as const,
      release: "24.1.0",
      arch: "x64",
      swVersStdout: "   ",
      expected: {
        platform: "darwin",
        arch: "x64",
        release: "24.1.0",
        label: "macos 24.1.0 (x64)",
      },
    },
    {
      name: "formats windows labels from os metadata",
      platform: "win32" as const,
      release: "10.0.26100",
      arch: "x64",
      expected: {
        platform: "win32",
        arch: "x64",
        release: "10.0.26100",
        label: "windows 10.0.26100 (x64)",
      },
    },
    {
      name: "formats non-darwin labels from os metadata",
      platform: "linux" as const,
      release: "10.0.26100",
      arch: "x64",
      expected: {
        platform: "linux",
        arch: "x64",
        release: "10.0.26100",
        label: "linux 10.0.26100 (x64)",
      },
    },
  ])("$name", ({ platform, release, arch, swVersStdout, expected }) => {
    vi.spyOn(os, "platform").mockReturnValue(platform);
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.spyOn(os, "arch").mockReturnValue(arch);
    if (platform === "darwin") {
      spawnSyncMock.mockReturnValue({
        stdout: swVersStdout ?? "",
        stderr: "",
        pid: 1,
        output: [],
        status: 0,
        signal: null,
      });
    }
    expect(resolveOsSummary()).toEqual(expected);
  });
});

describe("resolveRuntimeOsLabel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  it("reports the macOS product version without an architecture suffix on tahoe", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue("25.6.0");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    spawnSyncMock.mockReturnValue({
      stdout: "26.6.0\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    expect(resolveRuntimeOsLabel()).toBe("macOS 26.6.0");
    expect(spawnSyncMock).toHaveBeenCalledWith("sw_vers", ["-productVersion"], {
      encoding: "utf-8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
  });

  it("falls back to the Darwin release when sw_vers output is blank", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue("25.7.0");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    spawnSyncMock.mockReturnValue({
      stdout: "   ",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    expect(resolveRuntimeOsLabel()).toBe("macOS 25.7.0");
  });

  it("preserves the old Windows os.type/os.release shape", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    vi.spyOn(os, "type").mockReturnValue("Windows_NT");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    vi.spyOn(os, "arch").mockReturnValue("x64");

    expect(resolveRuntimeOsLabel()).toBe("Windows_NT 10.0.26100");
  });

  it("preserves the old Linux os.type/os.release shape", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "type").mockReturnValue("Linux");
    vi.spyOn(os, "release").mockReturnValue("6.8.0-generic");
    vi.spyOn(os, "arch").mockReturnValue("x64");

    expect(resolveRuntimeOsLabel()).toBe("Linux 6.8.0-generic");
  });

  it("caches the Darwin product version for repeated runtime prompt lookups", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue("25.8.0");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    spawnSyncMock.mockReturnValue({
      stdout: "26.8.0\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8.0");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8.0");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
