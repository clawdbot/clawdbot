import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const legacyCryptoInspectorAvailability = vi.hoisted(() => ({
  available: true,
}));

vi.mock("./legacy-crypto-inspector-availability.js", () => ({
  isMatrixLegacyCryptoInspectorAvailable: () => legacyCryptoInspectorAvailability.available,
}));

import { autoPrepareLegacyMatrixCrypto, detectLegacyMatrixCrypto } from "./legacy-crypto.js";
import { resolveMatrixAccountStorageRoot } from "./storage-paths.js";
import {
  MATRIX_DEFAULT_ACCESS_TOKEN,
  MATRIX_DEFAULT_DEVICE_ID,
  MATRIX_DEFAULT_USER_ID,
  MATRIX_OPS_ACCESS_TOKEN,
  MATRIX_OPS_ACCOUNT_ID,
  MATRIX_OPS_DEVICE_ID,
  MATRIX_OPS_USER_ID,
  MATRIX_TEST_HOMESERVER,
  writeFile,
  writeMatrixCredentials,
} from "./test-helpers.js";

function createDefaultMatrixConfig(): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: MATRIX_TEST_HOMESERVER,
        userId: MATRIX_DEFAULT_USER_ID,
        accessToken: MATRIX_DEFAULT_ACCESS_TOKEN,
      },
    },
  };
}

function writeDefaultLegacyCryptoFixture(home: string) {
  const stateDir = path.join(home, ".openclaw");
  const cfg = createDefaultMatrixConfig();
  const { rootDir } = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: MATRIX_TEST_HOMESERVER,
    userId: MATRIX_DEFAULT_USER_ID,
    accessToken: MATRIX_DEFAULT_ACCESS_TOKEN,
  });
  writeFile(
    path.join(rootDir, "crypto", "bot-sdk.json"),
    JSON.stringify({ deviceId: MATRIX_DEFAULT_DEVICE_ID }),
  );
  return { cfg, rootDir };
}

function createOpsLegacyCryptoFixture(params: {
  home: string;
  accessToken?: string;
  includeStoredCredentials?: boolean;
}) {
  const stateDir = path.join(params.home, ".openclaw");
  writeFile(
    path.join(stateDir, "matrix", "crypto", "bot-sdk.json"),
    JSON.stringify({ deviceId: MATRIX_OPS_DEVICE_ID }),
  );
  if (params.includeStoredCredentials) {
    writeMatrixCredentials(stateDir, {
      accountId: MATRIX_OPS_ACCOUNT_ID,
      accessToken: params.accessToken ?? MATRIX_OPS_ACCESS_TOKEN,
      deviceId: MATRIX_OPS_DEVICE_ID,
    });
  }
  const { rootDir } = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: MATRIX_TEST_HOMESERVER,
    userId: MATRIX_OPS_USER_ID,
    accessToken: params.accessToken ?? MATRIX_OPS_ACCESS_TOKEN,
    accountId: MATRIX_OPS_ACCOUNT_ID,
  });
  return { rootDir };
}

describe("matrix legacy encrypted-state migration", () => {
  afterEach(() => {
    legacyCryptoInspectorAvailability.available = true;
  });

  it("extracts a saved backup key into the new recovery-key path", async () => {
    await withTempHome(async (home) => {
      const { cfg, rootDir } = writeDefaultLegacyCryptoFixture(home);

      const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
      expect(detection.inspectorAvailable).toBe(true);
      expect(detection.warnings).toStrictEqual([]);
      expect(detection.plans).toHaveLength(1);

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
        deps: {
          inspectLegacyStore: async () => ({
            deviceId: MATRIX_DEFAULT_DEVICE_ID,
            roomKeyCounts: { total: 12, backedUp: 12 },
            backupVersion: "1",
            decryptionKeyBase64: "YWJjZA==",
          }),
        },
      });

      expect(result.migrated).toBe(true);
      expect(result.warnings).toStrictEqual([]);

      const recovery = JSON.parse(
        fs.readFileSync(path.join(rootDir, "recovery-key.json"), "utf8"),
      ) as {
        privateKeyBase64: string;
      };
      expect(recovery.privateKeyBase64).toBe("YWJjZA==");
    });
  });

  it("skips migration when no legacy Matrix plans exist", async () => {
    await withTempHome(async () => {
      const result = await autoPrepareLegacyMatrixCrypto({
        cfg: createDefaultMatrixConfig(),
        env: process.env,
      });

      expect(result).toEqual({
        migrated: false,
        changes: [],
        warnings: [],
      });
    });
  });

  it("warns when legacy local-only room keys cannot be recovered automatically", async () => {
    await withTempHome(async (home) => {
      const { cfg, rootDir } = writeDefaultLegacyCryptoFixture(home);

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
        deps: {
          inspectLegacyStore: async () => ({
            deviceId: MATRIX_DEFAULT_DEVICE_ID,
            roomKeyCounts: { total: 15, backedUp: 10 },
            backupVersion: null,
            decryptionKeyBase64: null,
          }),
        },
      });

      expect(result.migrated).toBe(true);
      expect(result.warnings).toContain(
        'Legacy Matrix encrypted state for account "default" contains 5 room key(s) that were never backed up. Backed-up keys can be restored automatically, but local-only encrypted history may remain unavailable after upgrade.',
      );
      expect(result.warnings).toContain(
        'Legacy Matrix encrypted state for account "default" cannot be fully converted automatically because the old rust crypto store does not expose all local room keys for export.',
      );
      const state = JSON.parse(
        fs.readFileSync(path.join(rootDir, "legacy-crypto-migration.json"), "utf8"),
      ) as { restoreStatus: string };
      expect(state.restoreStatus).toBe("manual-action-required");
    });
  });

  it("prefers stored credentials for named accounts when config is token-only", async () => {
    await withTempHome(async (home) => {
      const { rootDir } = createOpsLegacyCryptoFixture({
        home,
        includeStoredCredentials: true,
      });
      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: MATRIX_TEST_HOMESERVER,
                accessToken: MATRIX_OPS_ACCESS_TOKEN,
              },
            },
          },
        },
      };

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
        deps: {
          inspectLegacyStore: async () => ({
            deviceId: MATRIX_OPS_DEVICE_ID,
            roomKeyCounts: { total: 1, backedUp: 1 },
            backupVersion: "1",
            decryptionKeyBase64: "b3Bz",
          }),
        },
      });

      expect(result.migrated).toBe(true);
      expect(fs.existsSync(path.join(rootDir, "recovery-key.json"))).toBe(true);
    });
  });

  it("stays warning-only when the legacy crypto inspector artifact is unavailable", async () => {
    legacyCryptoInspectorAvailability.available = false;

    await withTempHome(async (home) => {
      const { cfg } = writeDefaultLegacyCryptoFixture(home);

      const detection = detectLegacyMatrixCrypto({ cfg, env: process.env });
      expect(detection.inspectorAvailable).toBe(false);
      expect(detection.plans).toHaveLength(1);
      expect(detection.warnings).toContain(
        "Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.",
      );

      const result = await autoPrepareLegacyMatrixCrypto({
        cfg,
        env: process.env,
      });

      expect(result).toEqual({
        migrated: false,
        changes: [],
        warnings: [
          "Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.",
        ],
      });
    });
  });
});
