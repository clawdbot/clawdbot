// Matrix tests cover doctor plugin behavior.
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanStaleMatrixPluginConfig,
  collectMatrixInstallPathWarnings,
  matrixDoctor,
} from "./doctor.js";

describe("matrix doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function runMatrixCompatibilityNormalize(
    params: Parameters<NonNullable<typeof matrixDoctor.normalizeCompatibilityConfig>>[0],
  ) {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected Matrix doctor compatibility normalizer");
    }
    return normalize(params);
  }

  function normalizeMatrixDmConfig(dm: Record<string, unknown>) {
    return runMatrixCompatibilityNormalize({
      cfg: {
        channels: {
          matrix: {
            dm,
          },
        },
      } as never,
    });
  }

  function expectChangeContaining(changes: readonly string[], fragment: string): void {
    expect(changes.join("\n")).toContain(fragment);
  }

  it("warns on stale custom Matrix plugin paths and cleans them", async () => {
    const missingPath = path.join(tmpdir(), `openclaw-matrix-missing-${Date.now()}`);
    await fs.rm(missingPath, { recursive: true, force: true });

    const warnings = await collectMatrixInstallPathWarnings({
      plugins: {
        installs: {
          matrix: { source: "path", sourcePath: missingPath, installPath: missingPath },
        },
      },
    });
    expect(warnings[0]).toContain("custom path that no longer exists");

    const cleaned = await cleanStaleMatrixPluginConfig({
      plugins: {
        installs: {
          matrix: { source: "path", sourcePath: missingPath, installPath: missingPath },
        },
        load: { paths: [missingPath, "/other/path"] },
        allow: ["matrix", "other-plugin"],
      },
    });
    expect(cleaned.changes[0]).toContain("Removed stale Matrix plugin references");
    expect(cleaned.config.plugins?.load?.paths).toEqual(["/other/path"]);
    expect(cleaned.config.plugins?.allow).toEqual(["other-plugin"]);
  });

  it("normalizes legacy Matrix room allow aliases to enabled", () => {
    const result = runMatrixCompatibilityNormalize({
      cfg: {
        channels: {
          matrix: {
            groups: {
              "!ops:example.org": {
                allow: true,
              },
            },
            accounts: {
              work: {
                rooms: {
                  "!legacy:example.org": {
                    allow: false,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    const matrixConfig = result.config.channels?.matrix as
      | {
          groups?: Record<string, unknown>;
          accounts?: Record<string, unknown>;
          network?: { dangerouslyAllowPrivateNetwork?: boolean };
        }
      | undefined;
    const workAccount = matrixConfig?.accounts?.work as
      | {
          rooms?: Record<string, unknown>;
          network?: { dangerouslyAllowPrivateNetwork?: boolean };
        }
      | undefined;

    expect(matrixConfig?.groups?.["!ops:example.org"]).toEqual({
      enabled: true,
    });
    expect(workAccount?.rooms?.["!legacy:example.org"]).toEqual({
      enabled: false,
    });
    expect(result.changes).toContain(
      "Moved channels.matrix.groups.!ops:example.org.allow → channels.matrix.groups.!ops:example.org.enabled (true).",
    );
    expect(result.changes).toContain(
      "Moved channels.matrix.accounts.work.rooms.!legacy:example.org.allow → channels.matrix.accounts.work.rooms.!legacy:example.org.enabled (false).",
    );
  });

  it("normalizes legacy Matrix private-network aliases", () => {
    const result = runMatrixCompatibilityNormalize({
      cfg: {
        channels: {
          matrix: {
            allowPrivateNetwork: true,
            accounts: {
              work: {
                allowPrivateNetwork: false,
              },
            },
          },
        },
      } as never,
    });

    const matrixConfig = result.config.channels?.matrix as
      | {
          accounts?: Record<string, unknown>;
          network?: { dangerouslyAllowPrivateNetwork?: boolean };
        }
      | undefined;
    const workAccount = matrixConfig?.accounts?.work as
      | {
          network?: { dangerouslyAllowPrivateNetwork?: boolean };
        }
      | undefined;

    expect(matrixConfig?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(workAccount?.network).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
    expect(result.changes).toContain(
      "Moved channels.matrix.allowPrivateNetwork → channels.matrix.network.dangerouslyAllowPrivateNetwork (true).",
    );
    expect(result.changes).toContain(
      "Moved channels.matrix.accounts.work.allowPrivateNetwork → channels.matrix.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
    );
  });

  it("migrates legacy channels.matrix.dm.policy 'trusted' with allowFrom to 'allowlist'", () => {
    const result = runMatrixCompatibilityNormalize({
      cfg: {
        channels: {
          matrix: {
            dm: {
              enabled: true,
              policy: "trusted",
              allowFrom: ["@alice:example.org", "@bob:example.org"],
            },
          },
        },
      } as never,
    });

    const matrixDm = (
      result.config.channels?.matrix as { dm?: { policy?: string; allowFrom?: string[] } }
    )?.dm;

    expect(matrixDm?.policy).toBe("allowlist");
    expect(matrixDm?.allowFrom).toEqual(["@alice:example.org", "@bob:example.org"]);
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.dm.policy "trusted" → "allowlist"',
    );
    expectChangeContaining(result.changes, "preserved 2 channels.matrix.dm.allowFrom entries");
  });

  it("migrates legacy 'trusted' policy with whitespace-only allowFrom entries to 'pairing'", () => {
    // Whitespace-only entries are dropped by downstream allowlist normalization,
    // so they must not count toward the allowFrom population check — otherwise
    // the migration would emit policy="allowlist" with an effectively empty
    // allowlist, silently blocking all DMs.
    const result = normalizeMatrixDmConfig({
      enabled: true,
      policy: "trusted",
      allowFrom: ["   ", "\t", ""],
    });

    const matrixDm = (result.config.channels?.matrix as { dm?: { policy?: string } })?.dm;
    expect(matrixDm?.policy).toBe("pairing");
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.dm.policy "trusted" → "pairing"',
    );
  });

  it("migrates legacy channels.matrix.dm.policy 'trusted' without allowFrom to 'pairing'", () => {
    const result = normalizeMatrixDmConfig({
      enabled: true,
      policy: "trusted",
    });

    const matrixDm = (result.config.channels?.matrix as { dm?: { policy?: string } })?.dm;
    expect(matrixDm?.policy).toBe("pairing");
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.dm.policy "trusted" → "pairing"',
    );
  });

  it("migrates legacy per-account channels.matrix.accounts.<id>.dm.policy 'trusted'", () => {
    const result = runMatrixCompatibilityNormalize({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              work: {
                dm: {
                  enabled: true,
                  policy: "trusted",
                  allowFrom: ["@boss:example.org"],
                },
              },
              personal: {
                dm: {
                  enabled: true,
                  policy: "trusted",
                },
              },
            },
          },
        },
      } as never,
    });

    const accounts = (
      result.config.channels?.matrix as {
        accounts?: Record<string, { dm?: { policy?: string; allowFrom?: string[] } }>;
      }
    )?.accounts;

    expect(accounts?.work?.dm?.policy).toBe("allowlist");
    expect(accounts?.work?.dm?.allowFrom).toEqual(["@boss:example.org"]);
    expect(accounts?.personal?.dm?.policy).toBe("pairing");
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.accounts.work.dm.policy "trusted" → "allowlist"',
    );
    expectChangeContaining(
      result.changes,
      'Migrated channels.matrix.accounts.personal.dm.policy "trusted" → "pairing"',
    );
  });

  it("leaves modern dm.policy values untouched", () => {
    const result = runMatrixCompatibilityNormalize({
      cfg: {
        channels: {
          matrix: {
            dm: {
              enabled: true,
              policy: "allowlist",
              allowFrom: ["@alice:example.org"],
            },
            accounts: {
              work: {
                dm: { enabled: true, policy: "pairing" },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.config).toEqual({
      channels: {
        matrix: {
          dm: {
            enabled: true,
            policy: "allowlist",
            allowFrom: ["@alice:example.org"],
          },
          accounts: {
            work: {
              dm: { enabled: true, policy: "pairing" },
            },
          },
        },
      },
    });
  });
});

describe("matrix doctor streaming alias migration", () => {
  function normalizeMatrixEntry(entry: Record<string, unknown>) {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected Matrix doctor compatibility normalizer");
    }
    return normalize({ cfg: { channels: { matrix: entry } } as never });
  }

  function matrixEntryOf(result: { config: unknown }): Record<string, unknown> {
    const channels = (result.config as { channels?: Record<string, unknown> }).channels;
    return channels?.matrix as Record<string, unknown>;
  }

  it("preserves the matrix-local quiet mode when migrating scalar streaming", () => {
    const result = normalizeMatrixEntry({ streaming: "quiet" });
    expect(matrixEntryOf(result).streaming).toEqual({ mode: "quiet" });
  });

  it("migrates boolean streaming plus flat delivery keys into the nested shape", () => {
    const result = normalizeMatrixEntry({
      streaming: true,
      blockStreaming: true,
      chunkMode: "newline",
    });
    expect(matrixEntryOf(result).streaming).toEqual({
      mode: "partial",
      chunkMode: "newline",
      block: { enabled: true },
    });
    const matrix = matrixEntryOf(result);
    expect(matrix.blockStreaming).toBeUndefined();
    expect(matrix.chunkMode).toBeUndefined();
  });

  it("leaves mode unset when only flat delivery keys migrate (matrix defaults to off)", () => {
    const result = normalizeMatrixEntry({ blockStreaming: true });
    // No mode source: streaming stays mode-less because runtime resolves both
    // "absent" and "object without mode" to "off".
    expect(matrixEntryOf(result).streaming).toEqual({ block: { enabled: true } });
  });

  it("seeds materialized account objects from root (account merge replaces wholesale)", () => {
    const result = normalizeMatrixEntry({
      streaming: { mode: "quiet", chunkMode: "newline" },
      accounts: {
        work: { blockStreaming: true },
      },
    });
    const accounts = matrixEntryOf(result).accounts as Record<string, Record<string, unknown>>;
    // Matrix's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root settings (copying
    // freezes inheritance at fix time by design; the change message says so).
    expect(accounts.work?.streaming).toEqual({
      mode: "quiet",
      chunkMode: "newline",
      block: { enabled: true },
    });
    expect(accounts.work?.blockStreaming).toBeUndefined();
  });

  it("seeds root FLAT delivery keys into accounts that already had a streaming value", () => {
    // Pre-migration, root flat keys resolved per-key for every account even
    // when the account's own streaming value replaced the root object
    // wholesale; migration must not silently drop that inherited behavior.
    const result = normalizeMatrixEntry({
      blockStreaming: true,
      accounts: {
        work: { streaming: { mode: "quiet" } },
      },
    });
    const accounts = matrixEntryOf(result).accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.streaming).toEqual({ mode: "quiet", block: { enabled: true } });
  });

  it("keeps canonical root nested values over conflicting account flat keys", () => {
    const result = normalizeMatrixEntry({
      streaming: { mode: "quiet", block: { enabled: false } },
      accounts: {
        work: { blockStreaming: true },
      },
    });
    const accounts = matrixEntryOf(result).accounts as Record<string, Record<string, unknown>>;
    // Pre-migration the resolvers read the merged nested object first, so the
    // account flat key was dead while root nested set block.enabled.
    expect(accounts.work?.streaming).toEqual({ mode: "quiet", block: { enabled: false } });
  });

  it("strips junk streamMode keys instead of treating them as mode intent", () => {
    // Matrix never had a streamMode key (no schema field, no runtime read), so
    // migrating it into streaming.mode would invent a mode the account never
    // ran with; the root scalar keeps flowing to the account at runtime.
    const result = normalizeMatrixEntry({
      streaming: "quiet",
      accounts: {
        work: { streamMode: "partial" },
      },
    });
    const matrix = matrixEntryOf(result);
    expect(matrix.streaming).toEqual({ mode: "quiet" });
    const accounts = matrix.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.streamMode).toBeUndefined();
    expect(accounts.work?.streaming).toBeUndefined();
  });

  it("is idempotent: a second run reports no changes", () => {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("expected Matrix doctor compatibility normalizer");
    }
    const first = normalizeMatrixEntry({ streaming: "quiet", blockStreaming: true });
    expect(first.changes.length).toBeGreaterThan(0);
    const second = normalize({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});
