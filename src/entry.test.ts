import { describe, expect, it, vi } from "vitest";
import { tryHandleRootHelpFastPath } from "./entry.js";

const outputPrecomputedRootHelpTextMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./cli/root-help-metadata.js", () => ({
  outputPrecomputedRootHelpText: outputPrecomputedRootHelpTextMock,
}));

describe("entry root help fast path", () => {
  it("prefers precomputed root help text when available", async () => {
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      env: {},
    });

    expect(handled).toBe(true);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
  });

  it("renders root help without importing the full program", async () => {
    const outputRootHelpMock = vi.fn();

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      outputRootHelp: outputRootHelpMock,
      env: {},
    });

    expect(handled).toBe(true);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
  });

  it("ignores non-root help invocations", async () => {
    const outputRootHelpMock = vi.fn();

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "status", "--help"], {
      outputRootHelp: outputRootHelpMock,
      env: {},
    });

    expect(handled).toBe(false);
    expect(outputRootHelpMock).not.toHaveBeenCalled();
  });

  it("skips the host help fast path when a container target is active", async () => {
    const outputRootHelpMock = vi.fn();

    const handled = await tryHandleRootHelpFastPath(
      ["node", "openclaw", "--container", "demo", "--help"],
      {
        outputRootHelp: outputRootHelpMock,
        env: {},
      },
    );

    expect(handled).toBe(false);
    expect(outputRootHelpMock).not.toHaveBeenCalled();
  });
});
