// Process-tree ancestry helpers for Windows scheduled-task gateway termination.
import { describe, expect, it } from "vitest";
import {
  buildWindowsParentPidIndex,
  isWindowsProcessDescendant,
  type WindowsProcessSnapshotEntry,
} from "./schtasks-process.js";

const SNAPSHOT: WindowsProcessSnapshotEntry[] = [
  { ProcessId: 4, ParentProcessId: 0, CommandLine: "System" },
  { ProcessId: 100, ParentProcessId: 4, CommandLine: "services.exe" },
  { ProcessId: 200, ParentProcessId: 100, CommandLine: "openclaw gateway --port 18789" },
  { ProcessId: 300, ParentProcessId: 200, CommandLine: "node exec child" },
  { ProcessId: 400, ParentProcessId: 300, CommandLine: "openclaw gateway restart" },
  { ProcessId: 500, ParentProcessId: 100, CommandLine: "unrelated.exe" },
];

describe("buildWindowsParentPidIndex", () => {
  it("maps each process to its parent and skips roots and self-parents", () => {
    const index = buildWindowsParentPidIndex(SNAPSHOT);
    expect(index.get(200)).toBe(100);
    expect(index.get(400)).toBe(300);
    expect(index.has(4)).toBe(false);
  });
});

describe("isWindowsProcessDescendant", () => {
  const index = buildWindowsParentPidIndex(SNAPSHOT);

  it("detects a deep descendant of the gateway", () => {
    expect(isWindowsProcessDescendant(400, 200, index)).toBe(true);
  });

  it("treats the ancestor itself as inside the tree", () => {
    expect(isWindowsProcessDescendant(200, 200, index)).toBe(true);
  });

  it("rejects unrelated processes", () => {
    expect(isWindowsProcessDescendant(500, 200, index)).toBe(false);
    expect(isWindowsProcessDescendant(100, 200, index)).toBe(false);
  });

  it("returns false for unknown pids and empty indexes", () => {
    expect(isWindowsProcessDescendant(9999, 200, index)).toBe(false);
    expect(isWindowsProcessDescendant(300, 200, new Map())).toBe(false);
  });
});
