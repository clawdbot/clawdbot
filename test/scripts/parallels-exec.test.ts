import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveMacosPrlctlInvocation,
  runMacosHostCommand,
} from "../../scripts/e2e/parallels/macos-exec.ts";

const host = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../scripts/e2e/parallels/host-command.ts", () => host);

function useHost(platform: NodeJS.Platform, arch = "arm64") {
  vi.stubGlobal("process", { ...process, platform, arch });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("macOS Parallels execution boundary", () => {
  it("preserves VM, command arguments, stdin, and the caller budget without replay", () => {
    useHost("darwin");
    const args = ["exec", "Synthetic VM", "--current-user", "/bin/sh -c 'exit 7'"];
    const options = { check: false, input: "guest input\n", timeoutMs: 45_000 };
    const result = { status: 7, stdout: "executed once\n", stderr: "guest error\n" };
    host.run.mockReturnValue(result);

    expect(runMacosHostCommand("prlctl", args, options)).toBe(result);
    expect(host.run).toHaveBeenCalledExactlyOnceWith(
      "python3",
      [
        "-B",
        fileURLToPath(new URL("../../scripts/e2e/parallels/parallels-exec.py", import.meta.url)),
        "--timeout-ms",
        "45000",
        "--",
        ...args,
      ],
      options,
    );
  });

  it.each([
    ["linux", "arm64", "prlctl", ["exec", "Linux VM", "true"]],
    ["win32", "x64", "prlctl", ["exec", "Windows VM", "whoami"]],
    ["darwin", "x64", "prlctl", ["exec", "Intel VM", "true"]],
    ["darwin", "arm64", "prlctl", ["snapshot-switch", "VM", "--id", "snapshot"]],
    ["darwin", "arm64", "prlctl", ["capture", "VM", "--file", "proof.png"]],
    ["darwin", "arm64", "git", ["rev-parse", "HEAD"]],
  ] as const)("leaves %s/%s %s %j unchanged", (platform, arch, command, args) => {
    useHost(platform, arch);
    expect(resolveMacosPrlctlInvocation(command, [...args], 1000)).toEqual({
      command,
      args,
    });
  });

  it("propagates a transport timeout without running a second client", () => {
    useHost("darwin");
    const error = new Error("transport timed out after output");
    host.run.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => runMacosHostCommand("prlctl", ["exec", "VM", "true"])).toThrow(error);
    expect(host.run).toHaveBeenCalledTimes(1);
  });
});

it.skipIf(process.platform === "win32")(
  "enforces SDK ownership, stdio, selection, and cleanup contracts without a real VM",
  () => {
    const fixture = fileURLToPath(new URL("./parallels-exec.test.py", import.meta.url));
    const result = spawnSync("python3", ["-B", fixture], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/\nOK\n/u);
  },
);
