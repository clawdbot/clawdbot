import { describe, expect, it } from "vitest";
import { assertResourceCeiling, sampleProcess } from "../../scripts/e2e/kitchen-sink-rpc-walk.mjs";

describe("kitchen-sink RPC process sampling", () => {
  it("samples RSS on Windows instead of silently disabling the resource guard", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: `${256 * 1024 * 1024} 1.5`, stderr: "" };
      },
    });

    expect(sample).toEqual({ cpuPercent: null, cpuSeconds: 1.5, rssMiB: 256 });
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args.join(" ")).toContain("Get-Process -Id 1234");
  });

  it("falls back to the legacy powershell command name on Windows", async () => {
    const commands: string[] = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string) => {
        commands.push(command);
        if (command === "powershell.exe") {
          throw new Error("missing powershell.exe");
        }
        return { stdout: `${96 * 1024 * 1024} 0`, stderr: "" };
      },
    });

    expect(commands).toEqual(["powershell.exe", "powershell"]);
    expect(sample?.rssMiB).toBe(96);
  });

  it("samples RSS and CPU percent with ps on POSIX", async () => {
    const sample = await sampleProcess(4321, {
      platform: "linux",
      runCommand: async (command: string, args: string[]) => {
        expect(command).toBe("ps");
        expect(args).toEqual(["-o", "rss=,pcpu=", "-p", "4321"]);
        return { stdout: "262144 12.5\n", stderr: "" };
      },
    });

    expect(sample).toEqual({ cpuPercent: 12.5, rssMiB: 256 });
  });

  it("fails when the sampled RSS exceeds the configured ceiling", () => {
    expect(() => assertResourceCeiling({ rssMiB: 2049 })).toThrow(
      "gateway RSS exceeded 2048 MiB: 2049 MiB",
    );
  });
});
