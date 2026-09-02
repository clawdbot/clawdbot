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

import {
  resolveDarwinProductVersion,
  resolveOsSummary,
  resolveRuntimeOsLabel,
} from "./os-summary.js";

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
    expect(resolveOsSummary().label).toBe("windows 10.0.26100 (x64)");
    expect(spawnSyncMock).not.toHaveBeenCalled();
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

describe("shared OS source facts and independent label outcomes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  function darwin(release: string) {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.spyOn(os, "arch").mockReturnValue("arm64");
  }

  it("keeps an early direct probe failure retryable by later label consumers", () => {
    darwin("90.1.0");
    spawnSyncMock.mockReturnValueOnce({ stdout: " " }).mockReturnValue({ stdout: "26.1\n" });
    expect(resolveDarwinProductVersion()).toBe("90.1.0");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.1");
    expect(resolveOsSummary()).toEqual({
      platform: "darwin",
      arch: "arm64",
      release: "90.1.0",
      label: "macos 26.1 (arm64)",
    });
  });

  it("retains a runtime fallback after a later diagnostic probe succeeds", () => {
    darwin("90.2.0");
    spawnSyncMock
      .mockReturnValueOnce({ stdout: null, error: new Error("probe unavailable") })
      .mockReturnValue({ stdout: "26.2" });
    expect(resolveRuntimeOsLabel()).toBe("macOS 90.2.0");
    expect(resolveOsSummary().label).toBe("macos 26.2 (arm64)");
    expect(resolveRuntimeOsLabel()).toBe("macOS 90.2.0");
    expect(resolveDarwinProductVersion()).toBe("26.2");
  });

  it("retains a diagnostic fallback after a later runtime probe succeeds", () => {
    darwin("90.3.0");
    spawnSyncMock.mockReturnValueOnce({ stdout: "" }).mockReturnValue({ stdout: "26.3" });
    const summary = resolveOsSummary();
    expect(summary.label).toBe("macos 90.3.0 (arm64)");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.3");
    expect(resolveOsSummary()).toBe(summary);
    expect(summary.label).toBe("macos 90.3.0 (arm64)");
  });

  it("does not publish a thrown probe as either label outcome", () => {
    darwin("90.4.0");
    const error = new Error("native probe threw");
    spawnSyncMock
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockReturnValue({ stdout: "26.4" });
    expect(() => resolveRuntimeOsLabel()).toThrow(error);
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.4");
    expect(resolveOsSummary().label).toBe("macos 26.4 (arm64)");
  });

  it("retains the existing nonblank stdout acceptance independently of exit status", () => {
    darwin("90.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: " 26.5\n",
      status: 1,
      signal: null,
      error: new Error("reported error"),
    });
    expect(resolveDarwinProductVersion()).toBe("26.5");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.5");
    expect(resolveOsSummary().label).toBe("macos 26.5 (arm64)");
  });

  it("keeps the mutable summary separate from runtime and source facts", () => {
    darwin("90.6.0");
    spawnSyncMock.mockReturnValue({ stdout: "26.6" });
    const summary = resolveOsSummary();
    expect(Object.keys(summary)).toEqual(["platform", "arch", "release", "label"]);
    summary.label = "caller label";
    summary.release = "caller release";
    summary.arch = "caller arch";
    expect(resolveOsSummary()).toBe(summary);
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.6");
    expect(resolveDarwinProductVersion()).toBe("26.6");
    expect(summary.label).toBe("caller label");
  });

  it("keeps raw platform release and architecture tuple boundaries", () => {
    darwin("90.7.0");
    spawnSyncMock.mockImplementation(() => ({ stdout: os.arch() === "arm64" ? "26.7" : "26.8" }));
    const arm = resolveOsSummary();
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.7");
    vi.mocked(os.arch).mockReturnValue("x64");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8");
    expect(resolveOsSummary().label).toBe("macos 26.8 (x64)");
    vi.mocked(os.arch).mockReturnValue("arm64");
    expect(resolveOsSummary()).toBe(arm);
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.7");
  });

  it("shares the first successful product version across later consumers", () => {
    darwin("90.8.0");
    spawnSyncMock.mockReturnValue({ stdout: "26.8" });
    expect(resolveDarwinProductVersion()).toBe("26.8");
    spawnSyncMock.mockReturnValue({ stdout: "27.0" });
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8");
    expect(resolveOsSummary()).toEqual({
      platform: "darwin",
      arch: "arm64",
      release: "90.8.0",
      label: "macos 26.8 (arm64)",
    });
    expect(resolveDarwinProductVersion()).toBe("26.8");
  });
});
