import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } =
    await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeChildProcessSpawnSync(spawnSyncMock);
});

import { resolveOsSummary } from "./os-summary.js";

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
