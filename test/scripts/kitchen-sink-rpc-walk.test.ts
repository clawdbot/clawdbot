import { describe, expect, it, vi } from "vitest";
import {
  assertResourceCeiling,
  fetchJson,
  sampleProcess,
  sampleWindowsProcessByPort,
  summarizeProcessSamples,
} from "../../scripts/e2e/kitchen-sink-rpc-walk.mjs";

describe("kitchen-sink RPC process sampling", () => {
  it("samples RSS on Windows instead of silently disabling the resource guard", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: `${256 * 1024 * 1024} 1.5 5678`, stderr: "" };
      },
    });

    expect(sample).toEqual({
      cpuPercent: null,
      cpuSeconds: 1.5,
      processId: 5678,
      rssMiB: 256,
    });
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args.join(" ")).toContain("Get-Process -Id 1234");
    expect(calls[0]?.args.join(" ")).not.toContain("ParentProcessId");
  });

  it("can locate a Windows gateway process by command line when the launcher is gone", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: `${384 * 1024 * 1024} 2.25 6789`, stderr: "" };
      },
      windowsCommandLineNeedles: ["gateway", "--port", "19080"],
    });

    expect(sample).toEqual({
      cpuPercent: null,
      cpuSeconds: 2.25,
      processId: 6789,
      rssMiB: 384,
    });
    const command = calls[0]?.args.join(" ") ?? "";
    expect(command).toContain("CommandLine");
    expect(command).toContain("'gateway'");
    expect(command).toContain("'19080'");
    expect(command).toContain("ProcessId -eq $PID");
    expect(command).toContain("ParentProcessId");
    expect(command).toContain("Sort-Object WorkingSet64 -Descending");
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
        return { stdout: `${96 * 1024 * 1024} 0 1234`, stderr: "" };
      },
    });

    expect(commands).toEqual(["powershell.exe", "powershell"]);
    expect(sample?.rssMiB).toBe(96);
  });

  it("samples the Windows gateway process by listening port", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === "netstat.exe") {
          return {
            stdout: [
              "  Proto  Local Address          Foreign Address        State           PID",
              "  TCP    127.0.0.1:19675        0.0.0.0:0              LISTENING       6789",
            ].join("\r\n"),
            stderr: "",
          };
        }
        if (command === "powershell.exe") {
          return { stdout: `${384 * 1024 * 1024} 2.25 6789`, stderr: "" };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    expect(sample).toEqual({
      cpuPercent: null,
      cpuSeconds: 2.25,
      processId: 6789,
      rssMiB: 384,
    });
    expect(calls).toEqual([
      { command: "netstat.exe", args: ["-ano", "-p", "tcp"] },
      {
        command: "powershell.exe",
        args: expect.arrayContaining(["-Command", expect.stringContaining("Get-Process -Id 6789")]),
      },
    ]);
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

  it("retries transient loopback fetch resets from Windows HTTP probes", async () => {
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(new Response('{"status":"live"}', { status: 200 }));

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 2,
        fetchImpl,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({ ok: true, status: 200, body: { status: "live" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails when the sampled RSS exceeds the configured ceiling", () => {
    expect(() => assertResourceCeiling({ rssMiB: 2049 })).toThrow(
      "gateway RSS exceeded 2048 MiB: 2049 MiB",
    );
  });

  it("summarizes peak RSS across repeated process samples", () => {
    expect(
      summarizeProcessSamples([
        { rssMiB: 128, cpuPercent: 2 },
        { rssMiB: 512, cpuPercent: 25 },
        { rssMiB: 256, cpuPercent: 8 },
      ]),
    ).toEqual({
      rssMiB: 512,
      cpuPercent: 25,
      sampleCount: 3,
      peakCpuPercent: 25,
    });
  });

  it("fails when process sampling does not capture RSS", () => {
    expect(() => assertResourceCeiling(null)).toThrow("gateway RSS sample was not captured");
  });
});
