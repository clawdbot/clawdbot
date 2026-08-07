// Tree-guard tests for the Windows scheduled-task restart path (#120134).
// Agent exec commands are direct children of the gateway; `taskkill /T` must
// not terminate a tree that contains the calling process, or an exec-driven
// `openclaw gateway restart` would kill itself before `schtasks /Run` runs.
import { describe, expect, it } from "vitest";
import { isProcessDescendantOf } from "./schtasks-process.js";

type Entry = { ProcessId?: number; ParentProcessId?: number; CommandLine?: string | null };

describe("isProcessDescendantOf", () => {
  it("returns true for a direct child of the target", () => {
    const snapshot: Entry[] = [
      { ProcessId: 100, ParentProcessId: 1, CommandLine: "gateway" },
      { ProcessId: 200, ParentProcessId: 100, CommandLine: "openclaw gateway restart" },
    ];
    expect(isProcessDescendantOf(100, 200, snapshot)).toBe(true);
  });

  it("returns true for a grandchild of the target", () => {
    const snapshot: Entry[] = [
      { ProcessId: 100, ParentProcessId: 1, CommandLine: "gateway" },
      { ProcessId: 150, ParentProcessId: 100, CommandLine: "node wrapper" },
      { ProcessId: 200, ParentProcessId: 150, CommandLine: "openclaw gateway restart" },
    ];
    expect(isProcessDescendantOf(100, 200, snapshot)).toBe(true);
  });

  it("returns true when the current process is the target itself", () => {
    const snapshot: Entry[] = [{ ProcessId: 100, ParentProcessId: 1, CommandLine: "gateway" }];
    expect(isProcessDescendantOf(100, 100, snapshot)).toBe(true);
  });

  it("returns false for a process outside the target tree", () => {
    const snapshot: Entry[] = [
      { ProcessId: 100, ParentProcessId: 1, CommandLine: "gateway" },
      { ProcessId: 200, ParentProcessId: 1, CommandLine: "unrelated cli" },
    ];
    expect(isProcessDescendantOf(100, 200, snapshot)).toBe(false);
  });

  it("returns false for an empty snapshot", () => {
    expect(isProcessDescendantOf(100, 200, [])).toBe(false);
  });

  it("returns false when the parent chain is not in the snapshot", () => {
    const snapshot: Entry[] = [
      { ProcessId: 100, ParentProcessId: 1, CommandLine: "gateway" },
      // 200's parent (150) is missing, so ancestry cannot be proven.
      { ProcessId: 200, ParentProcessId: 150, CommandLine: "restart cli" },
    ];
    expect(isProcessDescendantOf(100, 200, snapshot)).toBe(false);
  });

  it("terminates on a parent-cycle and returns false", () => {
    const snapshot: Entry[] = [
      { ProcessId: 100, ParentProcessId: 200, CommandLine: "gateway" },
      { ProcessId: 200, ParentProcessId: 100, CommandLine: "restart cli" },
    ];
    expect(isProcessDescendantOf(100, 200, snapshot)).toBe(true);
    expect(isProcessDescendantOf(300, 200, snapshot)).toBe(false);
  });

  it("treats missing or non-positive ParentProcessId as a root", () => {
    const snapshot: Entry[] = [
      { ProcessId: 100, CommandLine: "gateway" },
      { ProcessId: 200, ParentProcessId: 0, CommandLine: "restart cli" },
    ];
    expect(isProcessDescendantOf(100, 200, snapshot)).toBe(false);
  });
});
