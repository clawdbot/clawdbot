import { describe, expect, it } from "vitest";
import {
  parsePsCpuTimeMs,
  parsePsRssBytes,
  parseWindowsProcessCpuTimeMs,
  parseWindowsProcessTreeSnapshot,
  parseWindowsWorkingSetBytes,
} from "./process-tree-cpu.js";

describe("process tree CPU helpers", () => {
  it("parses ps CPU time strings", () => {
    expect(parsePsCpuTimeMs("00:01")).toBe(1_000);
    expect(parsePsCpuTimeMs("00:00.12")).toBe(120);
    expect(parsePsCpuTimeMs("01:02")).toBe(62_000);
    expect(parsePsCpuTimeMs("01:02:03.45")).toBe(3_723_450);
    expect(parsePsCpuTimeMs("1-02:03:04.5")).toBe(93_784_500);
  });

  it("rejects malformed ps CPU time strings", () => {
    expect(parsePsCpuTimeMs("")).toBeNull();
    expect(parsePsCpuTimeMs("nope")).toBeNull();
    expect(parsePsCpuTimeMs("1::02")).toBeNull();
    expect(parsePsCpuTimeMs("1-02:03")).toBeNull();
    expect(parsePsCpuTimeMs("01:60")).toBeNull();
    expect(parsePsCpuTimeMs("01:02:60")).toBeNull();
    expect(parsePsCpuTimeMs("1:2:3:4")).toBeNull();
  });

  it("parses ps RSS KiB values as bytes", () => {
    expect(parsePsRssBytes("1024")).toBe(1_048_576);
    expect(parsePsRssBytes("1.5")).toBe(1_536);
  });

  it("rejects malformed ps RSS values", () => {
    expect(parsePsRssBytes("")).toBeNull();
    expect(parsePsRssBytes("nope")).toBeNull();
    expect(parsePsRssBytes("-1")).toBeNull();
    expect(parsePsRssBytes("0x10")).toBeNull();
  });

  it("parses Windows process CPU and RSS counters", () => {
    expect(
      parseWindowsProcessCpuTimeMs({
        kernelModeTime: "20000",
        userModeTime: 30_000,
      }),
    ).toBe(5);
    expect(parseWindowsWorkingSetBytes("1048576")).toBe(1_048_576);
  });

  it("rejects non-decimal Windows process counters", () => {
    expect(
      parseWindowsProcessCpuTimeMs({
        kernelModeTime: "0x10",
        userModeTime: "30000",
      }),
    ).toBeNull();
    expect(parseWindowsWorkingSetBytes("0x1000")).toBeNull();
  });

  it("builds Windows process tree snapshots from PowerShell JSON", () => {
    const snapshot = parseWindowsProcessTreeSnapshot(
      JSON.stringify([
        {
          ProcessId: 100,
          ParentProcessId: 50,
          KernelModeTime: "10000",
          UserModeTime: "20000",
          WorkingSetSize: "1000",
        },
        {
          ProcessId: 101,
          ParentProcessId: 100,
          KernelModeTime: "30000",
          UserModeTime: "40000",
          WorkingSetSize: "2000",
        },
      ]),
    );

    expect(snapshot?.childrenByParent.get(50)).toEqual([100]);
    expect(snapshot?.childrenByParent.get(100)).toEqual([101]);
    expect(snapshot?.cpuByPid.get(100)).toBe(3);
    expect(snapshot?.cpuByPid.get(101)).toBe(7);
    expect(snapshot?.rssByPid.get(100)).toBe(1000);
    expect(snapshot?.rssByPid.get(101)).toBe(2000);
  });

  it("skips Windows process entries with non-decimal process ids", () => {
    const snapshot = parseWindowsProcessTreeSnapshot(
      JSON.stringify([
        {
          ProcessId: "0x64",
          ParentProcessId: 50,
          KernelModeTime: "10000",
          UserModeTime: "20000",
          WorkingSetSize: "1000",
        },
      ]),
    );

    expect(snapshot?.childrenByParent.size).toBe(0);
    expect(snapshot?.cpuByPid.size).toBe(0);
    expect(snapshot?.rssByPid.size).toBe(0);
  });
});
