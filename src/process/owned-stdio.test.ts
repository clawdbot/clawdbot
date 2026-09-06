import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOwnedStdioProcess, OwnedStdioCleanupError } from "./owned-stdio.js";

const createChild = vi.hoisted(() => vi.fn());
vi.mock("./supervisor/adapters/child.js", () => ({ createChildAdapter: createChild }));

afterEach(() => createChild.mockReset());

describe("owned stdio startup cleanup", () => {
  it("joins an admitted child's cleanup before reporting the original startup failure", async () => {
    const cleanup = createDeferred();
    const original = new Error("startup failed after admission");
    createChild.mockImplementation(({ onSpawnCleanup }) => {
      onSpawnCleanup(cleanup.promise);
      throw original;
    });
    const rejected = vi.fn();
    const starting = createOwnedStdioProcess({ argv: ["server"] }).catch((error: unknown) => {
      rejected(error);
      return error;
    });
    await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
    cleanup.resolve();
    expect(await starting).toBe(original);
  });

  it.each(["rejected", "unsettled"])(
    "reports %s constructor cleanup as uncertainty rather than an ordinary spawn error",
    async (outcome) => {
      const cleanup = createDeferred();
      const original = new Error("startup failed after admission");
      createChild.mockImplementation(({ onSpawnCleanup }) => {
        onSpawnCleanup(cleanup.promise);
        if (outcome === "rejected") {
          cleanup.reject(new Error("owner lost"));
        }
        throw original;
      });
      try {
        await expect(createOwnedStdioProcess({ argv: ["server"] })).rejects.toMatchObject({
          constructor: OwnedStdioCleanupError,
          cause: original,
        });
      } finally {
        cleanup.resolve();
      }
    },
  );
});
