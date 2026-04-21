import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMatrixDoctorRepair,
  cleanStaleMatrixPluginConfig,
  collectMatrixInstallPathWarnings,
  formatMatrixLegacyCryptoPreview,
  formatMatrixLegacyStatePreview,
  matrixDoctor,
  runMatrixDoctorSequence,
} from "./doctor.js";

vi.mock("./matrix-migration.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./matrix-migration.runtime.js")>(
    "./matrix-migration.runtime.js",
  );
  return {
    ...actual,
    maybeCreateMatrixMigrationSnapshot: vi.fn(),
    autoMigrateLegacyMatrixState: vi.fn(async () => ({ changes: [], warnings: [] })),
    autoPrepareLegacyMatrixCrypto: vi.fn(async () => ({ changes: [], warnings: [] })),
    resolveMatrixMigrationStatus: vi.fn(() => ({
      legacyState: null,
      legacyCrypto: { inspectorAvailable: true, warnings: [], plans: [] },
      pending: false,
      actionable: false,
    })),
  };
});

describe("matrix doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function normalizeMatrixDmConfig(dm: Record<string, unknown>) {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      throw new Error("expected Matrix doctor compatibility normalizer");
    }
    return normalize({
      cfg: {
        channels: {
          matrix: {
            dm,
          },
        },
      } as never,
    });
  }

  it("formats state and crypto previews", () => {
    expect(
      formatMatrixLegacyStatePreview({
        accountId: "default",
        legacyStoragePath: "/tmp/legacy-sync.json",
        targetStoragePath: "/tmp/new-sync.json",
        legacyCryptoPath: "/tmp/legacy-crypto.json",
        targetCryptoPath: "/tmp/new-crypto.json",
        selectionNote: "Picked the newest account.",
        targetRootDir: "/tmp/account-root",
      }),
    ).toContain("Matrix plugin upgraded in place.");

    const previews = formatMatrixLegacyCryptoPreview({
      inspectorAvailable: true,
      warnings: ["matrix warning"],
      plans: [
        {
          accountId: "default",
          rootDir: "/tmp/account-root",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
          legacyCryptoPath: "/tmp/legacy-crypto.json",
          recoveryKeyPath: "/tmp/recovery-key.txt",
          statePath: "/tmp/state.json",
        },
      ],
    });
    expect(previews[0]).toBe("- matrix warning");
    expect(previews[1]).toContain("/tmp/recovery-key.txt");
  });

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

  it("surfaces matrix sequence warnings and repair changes", async () => {
    const runtimeApi = await import("./matrix-migration.runtime.js");
    vi.mocked(runtimeApi.resolveMatrixMigrationStatus).mockReturnValue({
      legacyState: null,
      legacyCrypto: { inspectorAvailable: true, warnings: [], plans: [] },
      pending: true,
      actionable: true,
    });
    vi.mocked(runtimeApi.maybeCreateMatrixMigrationSnapshot).mockResolvedValue({
      archivePath: "/tmp/matrix-backup.tgz",
      created: true,
      markerPath: "/tmp/marker.json",
    });
    vi.mocked(runtimeApi.autoMigrateLegacyMatrixState).mockResolvedValue({
      migrated: true,
      changes: ["Migrated legacy sync state"],
      warnings: [],
    });
    vi.mocked(runtimeApi.autoPrepareLegacyMatrixCrypto).mockResolvedValue({
      migrated: true,
      changes: ["Prepared recovery key export"],
      warnings: [],
    });

    const cfg = {
      channels: {
        matrix: {},
      },
    } as never;

    const repair = await applyMatrixDoctorRepair({ cfg, env: process.env });
    expect(repair.changes.join("\n")).toContain("Matrix migration snapshot");

    const sequence = await runMatrixDoctorSequence({
      cfg,
      env: process.env,
      shouldRepair: true,
    });
    expect(sequence.changeNotes.join("\n")).toContain("Matrix migration snapshot");
  });

  it("normalizes legacy Matrix room allow aliases to enabled", () => {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
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
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.matrix.groups.!ops:example.org.allow → channels.matrix.groups.!ops:example.org.enabled (true).",
        "Moved channels.matrix.accounts.work.rooms.!legacy:example.org.allow → channels.matrix.accounts.work.rooms.!legacy:example.org.enabled (false).",
      ]),
    );
  });

  it("normalizes legacy Matrix private-network aliases", () => {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
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
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.matrix.allowPrivateNetwork → channels.matrix.network.dangerouslyAllowPrivateNetwork (true).",
        "Moved channels.matrix.accounts.work.allowPrivateNetwork → channels.matrix.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
      ]),
    );
  });

  it("migrates legacy channels.matrix.dm.policy 'trusted' with allowFrom to 'allowlist'", () => {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
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
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Migrated channels.matrix.dm.policy "trusted" → "allowlist"'),
        expect.stringContaining("preserved 2 channels.matrix.dm.allowFrom entries"),
      ]),
    );
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
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Migrated channels.matrix.dm.policy "trusted" → "pairing"'),
      ]),
    );
  });

  it("migrates legacy channels.matrix.dm.policy 'trusted' without allowFrom to 'pairing'", () => {
    const result = normalizeMatrixDmConfig({
      enabled: true,
      policy: "trusted",
    });

    const matrixDm = (result.config.channels?.matrix as { dm?: { policy?: string } })?.dm;
    expect(matrixDm?.policy).toBe("pairing");
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Migrated channels.matrix.dm.policy "trusted" → "pairing"'),
      ]),
    );
  });

  it("migrates legacy per-account channels.matrix.accounts.<id>.dm.policy 'trusted'", () => {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
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
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Migrated channels.matrix.accounts.work.dm.policy "trusted" → "allowlist"',
        ),
        expect.stringContaining(
          'Migrated channels.matrix.accounts.personal.dm.policy "trusted" → "pairing"',
        ),
      ]),
    );
  });

  it("leaves modern dm.policy values untouched", () => {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
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

    expect(result.changes).toEqual([]);
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
