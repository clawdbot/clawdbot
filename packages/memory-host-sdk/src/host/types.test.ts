import { describe, expect, it } from "vitest";
import { resolveMemorySearchStaleness, type MemoryProviderStatus } from "./types.js";

describe("memory search staleness", () => {
  it("keeps routine pending index work silent", () => {
    const status: MemoryProviderStatus = {
      backend: "builtin",
      provider: "none",
      dirty: true,
    };
    expect(resolveMemorySearchStaleness(status)).toBeNull();
  });

  it("reports the latest automatic sync failure", () => {
    expect(
      resolveMemorySearchStaleness({ lastSyncError: "embedding request timed out" }, "main"),
    ).toEqual({
      stale: true,
      warning:
        "Memory index is stale: embedding request timed out. Search results may be incomplete.",
      action: "Run: openclaw memory status --index --agent main",
    });
  });

  it("gives an incompatible index identity precedence over a sync failure", () => {
    expect(
      resolveMemorySearchStaleness({
        lastSyncError: "embedding request timed out",
        custom: {
          indexIdentity: { status: "mismatched", reason: "embedding model changed" },
        },
      }),
    ).toMatchObject({ warning: expect.stringContaining("embedding model changed") });
  });
});
