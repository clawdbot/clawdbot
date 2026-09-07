import { describe, expect, it } from "vitest";
import {
  resolveMemoryIndexIdentityDiagnostic,
  resolveMemorySearchStaleness,
  type MemoryProviderStatus,
} from "./types.js";

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
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });

  it("gives an incompatible index identity precedence over a sync failure", () => {
    expect(
      resolveMemorySearchStaleness({
        lastSyncError: "embedding request timed out",
        custom: {
          indexIdentity: {
            status: "mismatched",
            reason: "embedding model changed",
            code: "model",
            owner: "configuration",
          },
        },
      }),
    ).toMatchObject({ warning: expect.stringContaining("embedding model changed") });
  });

  it("attributes an OpenClaw-owned format mismatch and names the repair cost", () => {
    const status: MemoryProviderStatus = {
      backend: "builtin",
      provider: "openai",
      custom: {
        indexIdentity: {
          status: "mismatched",
          reason: "index provenance classifier changed",
          code: "provenance_version",
          owner: "openclaw",
        },
      },
    };
    expect(resolveMemoryIndexIdentityDiagnostic(status)).toEqual({
      status: "mismatched",
      reason: "index provenance classifier changed",
      code: "provenance_version",
      owner: "openclaw",
    });
    expect(resolveMemorySearchStaleness(status, "main")).toEqual({
      stale: true,
      warning:
        "Memory index is stale: index provenance classifier changed (owner: openclaw, code: provenance_version). Search results may be incomplete.",
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });

  it("does not claim provider cost for a keyword-only index", () => {
    expect(
      resolveMemorySearchStaleness(
        {
          provider: "none",
          requestedProvider: "none",
          custom: {
            indexIdentity: {
              status: "mismatched",
              reason: "index sources changed",
              code: "sources",
              owner: "configuration",
            },
          },
        },
        "main",
      ),
    ).toEqual({
      stale: true,
      warning:
        "Memory index is stale: index sources changed (owner: configuration, code: sources). Search results may be incomplete.",
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding uses keyword indexing only and does not call an embedding provider.",
    });
  });

  it("uses configured provider intent after runtime degradation", () => {
    expect(
      resolveMemorySearchStaleness(
        {
          provider: "none",
          requestedProvider: "openai",
          custom: {
            indexIdentity: {
              status: "mismatched",
              reason: "index provenance classifier changed",
              code: "provenance_version",
              owner: "openclaw",
            },
          },
        },
        "main",
      ),
    ).toMatchObject({
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });

  it.each([
    {
      status: "mismatched",
      reason: "missing code and owner",
    },
    {
      status: "mismatched",
      reason: "invalid owner for code",
      code: "provider",
      owner: "openclaw",
    },
    {
      status: "missing",
      reason: "invalid missing state",
      code: "metadata_missing",
      owner: "configuration",
    },
  ])("rejects malformed identity diagnostic %#", (indexIdentity) => {
    expect(resolveMemoryIndexIdentityDiagnostic({ custom: { indexIdentity } })).toBeUndefined();
  });
});
