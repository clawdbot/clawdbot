import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SecretRef } from "../config/types.secrets.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  assertSecretOwnerAvailable,
  SecretSurfaceUnavailableError,
} from "./runtime-degraded-state.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { writeSecretStoreEntry } from "./store/secret-store.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = createTempDirTracker();
const NOSTR_TEST_PRIVATE_KEY = "1".repeat(64);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("Nostr SecretRef runtime ownership", () => {
  it.each(["env", "file", "exec", "store"] as const)(
    "materializes a valid private key from the %s backend",
    async (source) => {
      if (source === "exec" && process.platform === "win32") {
        return;
      }
      const root = tempDirs.make("openclaw-nostr-secret-");
      const env = {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        PATH: process.env.PATH ?? "",
        NOSTR_ENV_KEY: NOSTR_TEST_PRIVATE_KEY,
      };
      let ref: SecretRef;
      let providers: Record<string, unknown> = {};

      if (source === "file") {
        const filePath = path.join(root, "secrets.json");
        await fs.writeFile(filePath, JSON.stringify({ nostr: { key: NOSTR_TEST_PRIVATE_KEY } }), {
          mode: 0o600,
        });
        providers = { vault: { source, path: filePath, mode: "json" } };
        ref = { source, provider: "vault", id: "/nostr/key" };
      } else if (source === "exec") {
        const command = path.join(root, "resolve-secret.sh");
        const response = JSON.stringify({
          protocolVersion: 1,
          values: { "nostr/key": NOSTR_TEST_PRIVATE_KEY },
        });
        await fs.writeFile(command, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${response}'\n`, {
          mode: 0o700,
        });
        providers = { vault: { source, command, jsonOnly: true, passEnv: ["PATH"] } };
        ref = { source, provider: "vault", id: "nostr/key" };
      } else if (source === "store") {
        writeSecretStoreEntry({
          scope: { kind: "team" },
          name: "NOSTR_STORE_KEY",
          value: NOSTR_TEST_PRIVATE_KEY,
          kind: "secret",
          updatedBy: "test",
          database: { env },
        });
        ref = { source, provider: "default", id: "NOSTR_STORE_KEY" };
      } else {
        ref = { source, provider: "default", id: "NOSTR_ENV_KEY" };
      }

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          secrets: { providers },
          channels: { nostr: { defaultAccount: "Team.A", privateKey: ref } },
        }),
        env,
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map([["nostr", "bundled"]]),
      });

      expect(snapshot.config.channels?.nostr?.privateKey).toBe(NOSTR_TEST_PRIVATE_KEY);
      expect(snapshot.secretOwners).toEqual([
        expect.objectContaining({ ownerKind: "account", ownerId: "nostr:team-a" }),
      ]);
      expect(snapshot.degradedOwners).toEqual([]);
    },
  );

  it("keeps a missing named account cold while its healthy channel sibling remains available", async () => {
    const missingRef = { source: "env", provider: "default", id: "MISSING_NOSTR_KEY" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          nostr: { defaultAccount: "Team.A", privateKey: missingRef },
          telegram: {
            botToken: { source: "env", provider: "default", id: "HEALTHY_TELEGRAM_TOKEN" },
          },
        },
      }),
      env: {
        NOSTR_PRIVATE_KEY: NOSTR_TEST_PRIVATE_KEY,
        HEALTHY_TELEGRAM_TOKEN: "123:healthy-token",
      },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map([
        ["nostr", "bundled"],
        ["telegram", "bundled"],
      ]),
    });

    expect(snapshot.config.channels?.nostr?.privateKey).toEqual(missingRef);
    expect(snapshot.config.channels?.telegram?.botToken).toBe("123:healthy-token");
    expect(snapshot.degradedOwners).toEqual([
      expect.objectContaining({
        ownerKind: "account",
        ownerId: "nostr:team-a",
        state: "unavailable",
        degradationState: "cold",
        paths: ["channels.nostr.privateKey"],
      }),
    ]);

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });
    expect(() => assertSecretOwnerAvailable("account", "nostr:team-a")).toThrow(
      SecretSurfaceUnavailableError,
    );
    expect(() => assertSecretOwnerAvailable("account", "telegram:default")).not.toThrow();
  });

  it("leaves a disabled exec SecretRef inactive without invoking its provider", async () => {
    const privateKey = { source: "exec", provider: "vault", id: "nostr/key" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            vault: {
              source: "exec",
              command: "/definitely/missing/nostr-secret-provider",
              jsonOnly: true,
            },
          },
        },
        channels: { nostr: { enabled: false, privateKey } },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map([["nostr", "bundled"]]),
    });

    expect(snapshot.config.channels?.nostr?.privateKey).toEqual(privateKey);
    expect(snapshot.degradedOwners).toEqual([]);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "channels.nostr.privateKey",
        }),
      ]),
    );
  });
});
