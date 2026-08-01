// ls tool tests cover deterministic directory listings and safe limit
// normalization for agent-visible file enumeration.
import { describe, expect, it, vi } from "vitest";
import { createLsToolDefinition, type LsOperations } from "./ls.js";

function operations(entries: string[]): LsOperations {
  return {
    exists: () => true,
    stat: (absolutePath) => ({
      isDirectory: () => absolutePath === "/workspace" || absolutePath.endsWith("/dir"),
    }),
    readdir: () => entries,
  };
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createLsToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function trackAbortListener(signal: AbortSignal) {
  const add = vi.spyOn(signal, "addEventListener");
  const remove = vi.spyOn(signal, "removeEventListener");
  return {
    expectReleased() {
      const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
      expect(listener).toBeDefined();
      expect(remove).toHaveBeenCalledWith("abort", listener);
    },
  };
}

describe("ls tool", () => {
  it("clamps non-positive limits instead of reporting a non-empty directory as empty", async () => {
    // Clamp to one entry so bad numeric input cannot hide directory contents.
    const tool = createLsToolDefinition("/workspace", {
      operations: operations(["beta.txt", "alpha.txt"]),
    });

    const result = await tool.execute("call-1", { limit: 0 }, undefined, undefined, {} as never);

    expect(textContent(result)).toBe(
      "alpha.txt\n\n[1 entries limit reached. Use limit=2 for more]",
    );
    expect(result.details?.entryLimitReached).toBe(1);
  });

  it("uses the default limit for non-finite values", async () => {
    const tool = createLsToolDefinition("/workspace", {
      operations: operations(["beta.txt", "alpha.txt"]),
    });

    const result = await tool.execute(
      "call-1",
      { limit: Number.NaN },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("alpha.txt\nbeta.txt");
    expect(result.details).toBeUndefined();
  });

  it.each([
    {
      name: "missing path",
      operations: { ...operations([]), exists: () => false },
      error: "Path not found: /workspace",
    },
    {
      name: "non-directory path",
      operations: {
        ...operations([]),
        stat: () => ({ isDirectory: () => false }),
      },
      error: "Not a directory: /workspace",
    },
    {
      name: "directory read failure",
      operations: {
        ...operations([]),
        readdir: () => {
          throw new Error("permission denied");
        },
      },
      error: "Cannot read directory: permission denied",
    },
  ])("releases the abort listener after $name", async ({ operations: ops, error }) => {
    const tool = createLsToolDefinition("/workspace", { operations: ops });
    const controller = new AbortController();
    const listener = trackAbortListener(controller.signal);

    await expect(
      tool.execute("call-1", {}, controller.signal, undefined, {} as never),
    ).rejects.toThrow(error);

    listener.expectReleased();
  });

  it("releases the abort listener after success", async () => {
    const tool = createLsToolDefinition("/workspace", { operations: operations(["alpha.txt"]) });
    const controller = new AbortController();
    const listener = trackAbortListener(controller.signal);

    await expect(
      tool.execute("call-1", {}, controller.signal, undefined, {} as never),
    ).resolves.toBeDefined();

    listener.expectReleased();
  });

  it("settles once and releases the listener when aborted during an operation", async () => {
    let finishExists: (() => void) | undefined;
    const tool = createLsToolDefinition("/workspace", {
      operations: {
        ...operations([]),
        exists: () =>
          new Promise<boolean>((resolve) => {
            finishExists = () => resolve(true);
          }),
      },
    });
    const controller = new AbortController();
    const listener = trackAbortListener(controller.signal);
    const result = tool.execute("call-1", {}, controller.signal, undefined, {} as never);

    controller.abort();

    await expect(result).rejects.toThrow("Operation aborted");
    listener.expectReleased();
    finishExists?.();
  });
});
