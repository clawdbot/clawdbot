import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { findBundledPluginMetadataById } from "../plugins/bundled-plugin-metadata.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";
import { runtimePluginManifestSecretOwnerId } from "./runtime-plugin-manifest-secret-owner.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { writeSecretStoreEntry } from "./store/secret-store.js";
import { buildSecretTargetRegistryFromPlugins } from "./target-registry-data.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = createTempDirTracker();
const BEAM_TOKEN_PATH = "plugins.entries.beam.config.mirror.token";
const BEAM_TOKEN = "synthetic-beam-mirror-credential";
const BEAM_RUNTIME_OWNER_ID = runtimePluginManifestSecretOwnerId("beam", "beam-mirror");
const BEAM_ENV_REF = {
  source: "env",
  provider: "default",
  id: "OPENCLAW_BEAM_MIRROR_OWNER_TOKEN",
} as const;
const BEAM_PLUGIN_ORIGINS = new Map([["beam", "bundled" as const]]);
let bundledBeamRecord: PluginManifestRecord | undefined;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function getBundledBeamRecord(): PluginManifestRecord {
  if (bundledBeamRecord) {
    return bundledBeamRecord;
  }
  const metadata = findBundledPluginMetadataById("beam", {
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  });
  if (!metadata) {
    throw new Error("bundled Beam plugin manifest was not found");
  }
  const rootDir = fileURLToPath(new URL("../../extensions/beam", import.meta.url));
  bundledBeamRecord = {
    id: metadata.manifest.id,
    origin: "bundled",
    rootDir,
    source: path.join(rootDir, metadata.source.source),
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    configContracts: metadata.manifest.configContracts,
  };
  return bundledBeamRecord;
}

function createBeamConfig(params: {
  token: SecretRef | string;
  mirror?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  siblingRef?: SecretRef;
}): OpenClawConfig {
  return asConfig({
    agents: { list: [{ id: "main", default: true }] },
    ...(params.providers ? { secrets: { providers: params.providers } } : {}),
    ...(params.siblingRef
      ? { skills: { entries: { healthy: { apiKey: params.siblingRef } } } }
      : {}),
    plugins: {
      entries: {
        beam: {
          enabled: true,
          config: {
            mirror: {
              endpoint: "https://beam.example.invalid/api/v1/beam/sessions",
              token: params.token,
              catalogs: ["claude"],
              pollSeconds: 30,
              activeWindowMinutes: 180,
              ...params.mirror,
            },
          },
        },
      },
    },
  });
}

function prepareBeamSnapshot(config: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  return prepareSecretsRuntimeSnapshot({
    config,
    env,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: BEAM_PLUGIN_ORIGINS,
    manifestRegistry: { plugins: [getBundledBeamRecord()] },
  });
}

function readBeamMirrorToken(config: OpenClawConfig): unknown {
  return (config.plugins?.entries?.beam?.config?.mirror as { token?: unknown } | undefined)?.token;
}

describe("Beam mirror SecretRef owner boundary", () => {
  it("declares one exact capability owner, behavior contract, and inventory target", () => {
    const record = getBundledBeamRecord();

    expect(record.configContracts?.secretInputs?.paths).toEqual([
      {
        path: "mirror.token",
        expected: "string",
        ownerKind: "capability",
        ownerId: "beam-mirror",
        ownerContractFields: [
          "endpoint",
          "token",
          "catalogs",
          "pollSeconds",
          "activeWindowMinutes",
        ],
      },
    ]);
    expect(
      buildSecretTargetRegistryFromPlugins([record]).filter(
        (entry) => entry.pathPattern === BEAM_TOKEN_PATH,
      ),
    ).toMatchObject([
      {
        id: BEAM_TOKEN_PATH,
        configFile: "openclaw.json",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
    ]);
  });

  it.each(["env", "file", "exec", "store"] as const)(
    "materializes the %s backend once into the Beam owner snapshot",
    async (source) => {
      if (source === "exec" && process.platform === "win32") {
        return;
      }
      const root = tempDirs.make("openclaw-beam-secret-owner-");
      const env = {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        PATH: process.env.PATH ?? "",
        [BEAM_ENV_REF.id]: BEAM_TOKEN,
      };
      let ref: SecretRef = BEAM_ENV_REF;
      let providers: Record<string, unknown> = {};
      let execCallsPath: string | undefined;

      if (source === "file") {
        const secretFile = path.join(root, "secrets.json");
        await fs.writeFile(secretFile, JSON.stringify({ beam: { token: BEAM_TOKEN } }), {
          mode: 0o600,
        });
        providers = { vault: { source, path: secretFile, mode: "json" } };
        ref = { source, provider: "vault", id: "/beam/token" };
      } else if (source === "exec") {
        const command = path.join(root, "resolve-beam-secret.sh");
        execCallsPath = path.join(root, "exec-calls.log");
        const response = JSON.stringify({
          protocolVersion: 1,
          values: { "beam/token": BEAM_TOKEN },
        });
        await fs.writeFile(
          command,
          [
            "#!/bin/sh",
            `printf 'called\\n' >> ${JSON.stringify(execCallsPath)}`,
            "cat >/dev/null",
            `printf '%s' '${response}'`,
          ].join("\n"),
          { mode: 0o700 },
        );
        providers = { vault: { source, command, jsonOnly: true, passEnv: ["PATH"] } };
        ref = { source, provider: "vault", id: "beam/token" };
      } else if (source === "store") {
        writeSecretStoreEntry({
          scope: { kind: "team" },
          name: "OPENCLAW_BEAM_MIRROR_STORE_TOKEN",
          value: BEAM_TOKEN,
          kind: "secret",
          updatedBy: "test",
          database: { env },
        });
        ref = { source, provider: "default", id: "OPENCLAW_BEAM_MIRROR_STORE_TOKEN" };
      }

      const snapshot = await prepareBeamSnapshot(createBeamConfig({ token: ref, providers }), env);

      expect(readBeamMirrorToken(snapshot.config)).toBe(BEAM_TOKEN);
      expect(snapshot.secretOwners).toEqual([
        expect.objectContaining({
          ownerKind: "plugin-capability",
          ownerId: BEAM_RUNTIME_OWNER_ID,
        }),
      ]);
      expect(snapshot.degradedOwners).toEqual([]);
      if (execCallsPath) {
        expect(await fs.readFile(execCallsPath, "utf8")).toBe("called\n");
        expect(readBeamMirrorToken(snapshot.config)).toBe(BEAM_TOKEN);
        expect(readBeamMirrorToken(snapshot.config)).toBe(BEAM_TOKEN);
        expect(await fs.readFile(execCallsPath, "utf8")).toBe("called\n");
      }
    },
  );

  it("isolates only the cold mirror capability while its plugin and healthy sibling remain usable", async () => {
    const missing = {
      source: "env",
      provider: "default",
      id: "OPENCLAW_BEAM_MIRROR_OWNER_MISSING",
    } as const;
    const sibling = {
      source: "env",
      provider: "default",
      id: "OPENCLAW_BEAM_MIRROR_HEALTHY_SIBLING",
    } as const;
    const snapshot = await prepareBeamSnapshot(
      createBeamConfig({ token: missing, siblingRef: sibling }),
      { [sibling.id]: "healthy-sibling-credential" },
    );

    expect(readBeamMirrorToken(snapshot.config)).toEqual(missing);
    expect(snapshot.config.plugins?.entries?.beam?.enabled).toBe(true);
    expect(snapshot.config.skills?.entries?.healthy?.apiKey).toBe("healthy-sibling-credential");
    expect(snapshot.degradedOwners).toEqual([
      expect.objectContaining({
        ownerKind: "plugin-capability",
        ownerId: BEAM_RUNTIME_OWNER_ID,
        state: "unavailable",
        degradationState: "cold",
        paths: [BEAM_TOKEN_PATH],
        reason: "secret reference was not found",
      }),
    ]);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SECRETS_OWNER_UNAVAILABLE", path: BEAM_TOKEN_PATH }),
      ]),
    );

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });
    expect(() => assertSecretOwnerAvailable("plugin-capability", BEAM_RUNTIME_OWNER_ID)).toThrow(
      "configured but unavailable",
    );
    expect(() => assertSecretOwnerAvailable("capability", "skill:healthy")).not.toThrow();
  });

  it("reuses a stale mirror credential when only an unrelated sibling contract changes", async () => {
    const firstSibling = {
      source: "env",
      provider: "default",
      id: "OPENCLAW_BEAM_MIRROR_FIRST_SIBLING",
    } as const;
    const nextSibling = {
      source: "env",
      provider: "default",
      id: "OPENCLAW_BEAM_MIRROR_NEXT_SIBLING",
    } as const;
    const active = await prepareBeamSnapshot(
      createBeamConfig({ token: BEAM_ENV_REF, siblingRef: firstSibling }),
      { [BEAM_ENV_REF.id]: BEAM_TOKEN, [firstSibling.id]: "first-sibling" },
    );
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const refreshed = await prepareBeamSnapshot(
      createBeamConfig({ token: BEAM_ENV_REF, siblingRef: nextSibling }),
      { [nextSibling.id]: "next-sibling" },
    );

    expect(readBeamMirrorToken(refreshed.config)).toBe(BEAM_TOKEN);
    expect(refreshed.config.skills?.entries?.healthy?.apiKey).toBe("next-sibling");
    expect(refreshed.degradedOwners).toEqual([
      expect.objectContaining({
        ownerKind: "plugin-capability",
        ownerId: BEAM_RUNTIME_OWNER_ID,
        degradationState: "stale",
      }),
    ]);
  });

  it.each([
    ["endpoint", "https://different.example.invalid/api/v1/beam/sessions"],
    ["token", { source: "env", provider: "default", id: "OPENCLAW_BEAM_MIRROR_REPLACEMENT_TOKEN" }],
    ["catalogs", ["codex"]],
    ["pollSeconds", 60],
    ["activeWindowMinutes", 360],
  ] as const)(
    "never reuses a stale credential after the mirror %s changes",
    async (field, value) => {
      const active = await prepareBeamSnapshot(createBeamConfig({ token: BEAM_ENV_REF }), {
        [BEAM_ENV_REF.id]: BEAM_TOKEN,
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: active,
        refreshContext: null,
        refreshHandler: null,
      });

      const refreshed = await prepareBeamSnapshot(
        createBeamConfig({ token: BEAM_ENV_REF, mirror: { [field]: value } }),
      );

      expect(readBeamMirrorToken(refreshed.config)).toEqual(
        field === "token" ? value : BEAM_ENV_REF,
      );
      expect(refreshed.degradedOwners).toEqual([
        expect.objectContaining({
          ownerKind: "plugin-capability",
          ownerId: BEAM_RUNTIME_OWNER_ID,
          degradationState: "cold",
        }),
      ]);
      expect(JSON.stringify(refreshed.config)).not.toContain(BEAM_TOKEN);
    },
  );
});
