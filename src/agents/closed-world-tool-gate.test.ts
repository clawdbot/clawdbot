import { afterEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  applyClosedWorldToolGate,
  __resetClosedWorldGateDedupForTests,
} from "./closed-world-tool-gate.js";

function tool(name: string): AnyAgentTool {
  // The gate only reads `.name`; a bare stub is sufficient.
  return { name } as unknown as AnyAgentTool;
}

const SNAPSHOT = JSON.stringify({
  tool_names: ["ohlcv_tail", "recall_decisions", "web_search", "read", "memory"],
});

describe("closed-world tool gate", () => {
  afterEach(() => {
    __resetClosedWorldGateDedupForTests();
  });

  it("no snapshot -> log-only, passes every tool through (zero risk)", () => {
    const tools = [tool("ohlcv_tail"), tool("exec"), tool("write")];
    const result = applyClosedWorldToolGate(tools, { emit: false });
    expect(result.snapshotPresent).toBe(false);
    expect(result.tools).toHaveLength(3);
    expect(result.wouldDeny).toEqual([]);
  });

  it("report mode -> computes would-deny but passes ALL tools through unchanged", () => {
    const tools = [tool("ohlcv_tail"), tool("read"), tool("exec"), tool("cron")];
    const result = applyClosedWorldToolGate(tools, {
      snapshotJson: SNAPSHOT,
      modeRaw: "report",
      emit: false,
    });
    expect(result.mode).toBe("report");
    expect(result.snapshotPresent).toBe(true);
    // exec + cron are NOT in the snapshot -> flagged as would-deny...
    expect(result.wouldDeny.sort()).toEqual(["cron", "exec"]);
    // ...but report mode NEVER filters.
    expect(result.tools).toHaveLength(4);
  });

  it("enforce mode -> filters out tools not in the snapshot", () => {
    const tools = [tool("ohlcv_tail"), tool("read"), tool("exec"), tool("cron")];
    const result = applyClosedWorldToolGate(tools, {
      snapshotJson: SNAPSHOT,
      modeRaw: "enforce",
      emit: false,
    });
    expect(result.mode).toBe("enforce");
    expect(result.wouldDeny.sort()).toEqual(["cron", "exec"]);
    const kept = result.tools.map((t) => t.name).sort();
    expect(kept).toEqual(["ohlcv_tail", "read"]);
  });

  it("enforce mode with everything admitted -> passes through, empty would-deny", () => {
    const tools = [tool("ohlcv_tail"), tool("recall_decisions")];
    const result = applyClosedWorldToolGate(tools, {
      snapshotJson: SNAPSHOT,
      modeRaw: "enforce",
      emit: false,
    });
    expect(result.wouldDeny).toEqual([]);
    expect(result.tools).toHaveLength(2);
  });

  it("mode defaults to report for any non-'enforce' value", () => {
    const tools = [tool("exec")];
    for (const modeRaw of ["", "REPORT", "audit", undefined as unknown as string]) {
      const result = applyClosedWorldToolGate(tools, {
        snapshotJson: SNAPSHOT,
        modeRaw,
        emit: false,
      });
      expect(result.mode).toBe("report");
      expect(result.tools).toHaveLength(1);
    }
  });

  it("normalizes tool-name aliases (bash -> exec) before matching", () => {
    // snapshot admits neither; bash normalizes to exec, still absent -> would-deny 'exec'.
    const result = applyClosedWorldToolGate([tool("bash")], {
      snapshotJson: SNAPSHOT,
      modeRaw: "enforce",
      emit: false,
    });
    expect(result.resolved).toEqual(["exec"]);
    expect(result.wouldDeny).toEqual(["exec"]);
    expect(result.tools).toHaveLength(0);
  });

  it("a malformed snapshot JSON degrades to log-only (never throws / filters)", () => {
    const result = applyClosedWorldToolGate([tool("exec")], {
      snapshotJson: "{not valid json",
      modeRaw: "enforce",
      emit: false,
    });
    expect(result.snapshotPresent).toBe(false);
    expect(result.tools).toHaveLength(1);
  });
});
