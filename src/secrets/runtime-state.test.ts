/** Tests secrets runtime state clone isolation and refresh context. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshot,
  noteRuntimeAuthProfileStorePersistedMutation,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { testing as runtimeSnapshotsTesting } from "../agents/auth-profiles/runtime-snapshots.test-support.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { captureEnv } from "../test-utils/env.js";
import {
  activateSecretsRuntimeSnapshotState,
  activateSecretsRuntimeSnapshotStateIfCurrent,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  restoreSecretsRuntimeSnapshotStateIfCurrent,
  setSecretsRuntimeSourceSnapshotIfCurrent,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

describe("secrets runtime state", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    runtimeSnapshotsTesting.resetPersistedMutationLineage();
    envSnapshot.restore();
  });

  it("exposes the active config pair for hot paths without requiring the full snapshot", () => {
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: { agents: { list: [{ id: "source" }] } },
      config: { agents: { list: [{ id: "runtime" }] } },
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });

    const configSnapshot = getActiveSecretsRuntimeConfigSnapshot();
    const fullSnapshot = getActiveSecretsRuntimeSnapshot();

    expect(configSnapshot?.config).not.toBe(fullSnapshot?.config);
    expect(configSnapshot?.sourceConfig).not.toBe(fullSnapshot?.sourceConfig);
    expect(configSnapshot?.config).toEqual(snapshot.config);
    expect(configSnapshot?.sourceConfig).toEqual(snapshot.sourceConfig);
  });

  it("publishes distinct raw and overlay source snapshots without changing runtime auth", () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "OPENCLAW_DEBUG_AUTH_TOKEN",
    };
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token", token: secretRef } } },
      config: { gateway: { auth: { mode: "token", token: "resolved-debug-token" } } },
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };
    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });
    const metadata = getRuntimeConfigSnapshotMetadata();
    if (!metadata) {
      throw new Error("expected runtime config metadata");
    }
    const rawSourceConfig = { gateway: { port: 19_030 } } satisfies OpenClawConfig;
    const secretsSourceConfig = {
      ...rawSourceConfig,
      gateway: { ...rawSourceConfig.gateway, auth: { mode: "token" as const, token: secretRef } },
    } satisfies OpenClawConfig;

    expect(
      setSecretsRuntimeSourceSnapshotIfCurrent({
        expectedSecretsRevision: getActiveSecretsRuntimeSnapshotRevision(),
        expectedRuntimeConfigRevision: metadata.revision,
        runtimeSourceConfig: rawSourceConfig,
        secretsSourceConfig,
      }),
    ).toBe(true);

    expect(getRuntimeConfigSourceSnapshot()).toEqual(rawSourceConfig);
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(secretsSourceConfig);
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(snapshot.config);
  });

  it("preserves live auth bookkeeping when prepared credentials activate", () => {
    const agentDir = "/tmp/openclaw-auth-bookkeeping-merge";
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      key: "sk-current",
    };
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: { "openai:default": credential },
        usageStats: { "openai:default": { lastUsed: 1 } },
      },
      agentDir,
    );
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: {},
      config: {},
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: { "openai:default": credential },
            usageStats: { "openai:default": { lastUsed: 1 } },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: { "openai:default": credential },
        usageStats: {
          "openai:default": { lastUsed: 2, cooldownUntil: Date.now() + 60_000 },
        },
      },
      agentDir,
    );

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });

    expect(
      getRuntimeAuthProfileStoreSnapshot(agentDir)?.usageStats?.["openai:default"],
    ).toMatchObject({ lastUsed: 2, cooldownUntil: expect.any(Number) });
  });

  it("removes candidate-only auth profiles when rolling config back", () => {
    const agentDir = "/tmp/openclaw-auth-rollback-cas";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot();
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
    const candidate = snapshot("sk-old", 19_002);
    candidate.authStores[0]!.store.profiles["anthropic:candidate"] = {
      type: "api_key",
      provider: "anthropic",
      key: "sk-rejected-candidate",
    };
    expect(previous).not.toBeNull();
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous!,
        expectedRevision: candidateRevision,
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_001);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "sk-old",
    });
    expect(
      getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["anthropic:candidate"],
    ).toBeUndefined();
  });

  it("rolls back candidate credentials against the activation-time auth baseline", () => {
    const agentDir = "/tmp/openclaw-auth-activation-baseline";
    const profile = (provider: string, key: string) => ({
      type: "api_key" as const,
      provider,
      key,
    });
    const snapshot = (
      profiles: AuthProfileStore["profiles"],
      port: number,
      state: Pick<AuthProfileStore, "order" | "lastGood" | "usageStats"> = {},
    ): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [{ agentDir, store: { version: 1, profiles, ...state } }],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    const predecessorProfiles = {
      "provider-a:default": profile("provider-a", "a-old"),
      "provider-b:default": profile("provider-b", "b-old"),
    };
    const predecessorState = {
      order: { provider: ["provider-a:default", "provider-b:default"] },
      lastGood: { provider: "provider-a:default" },
      usageStats: { "provider-b:default": { lastUsed: 1 } },
    };
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot(predecessorProfiles, 19_001, predecessorState),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
    const activationProfiles = {
      ...predecessorProfiles,
      "provider-b:default": profile("provider-b", "b-external"),
      "provider-q:login": profile("provider-q", "q-external"),
    };
    const activationState = {
      order: { provider: ["provider-b:default", "provider-a:default"] },
      lastGood: { provider: "provider-b:default" },
      usageStats: {
        "provider-b:default": { lastUsed: 2, cooldownUntil: 30_000 },
      },
    };
    setRuntimeAuthProfileStoreSnapshot(
      { version: 1, profiles: activationProfiles, ...activationState },
      agentDir,
    );
    const preparedState = {
      order: { provider: ["provider-a:default"] },
      lastGood: { provider: "provider-a:default" },
      usageStats: { "provider-b:default": { lastUsed: 3 } },
    };
    const candidate = snapshot(
      {
        ...activationProfiles,
        "provider-a:default": profile("provider-a", "a-candidate"),
        "provider-x:candidate": profile("provider-x", "x-candidate"),
      },
      19_002,
      preparedState,
    );
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const liveAfterActivation = getRuntimeAuthProfileStoreSnapshot(agentDir)!;
    liveAfterActivation.order = { provider: ["provider-q:login", "provider-b:default"] };
    liveAfterActivation.lastGood = { provider: "provider-q:login" };
    liveAfterActivation.usageStats = {
      "provider-b:default": { lastUsed: 4, cooldownUntil: 40_000 },
    };
    setRuntimeAuthProfileStoreSnapshot(liveAfterActivation, agentDir);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const restored = getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles;
    expect(restored?.["provider-a:default"]).toMatchObject({ key: "a-old" });
    expect(restored?.["provider-b:default"]).toMatchObject({ key: "b-external" });
    expect(restored?.["provider-q:login"]).toMatchObject({ key: "q-external" });
    expect(restored?.["provider-x:candidate"]).toBeUndefined();
    const restoredStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    expect(restoredStore?.order?.provider).toEqual(["provider-q:login", "provider-b:default"]);
    expect(restoredStore?.lastGood?.provider).toBe("provider-q:login");
    expect(restoredStore?.usageStats?.["provider-b:default"]).toMatchObject({
      lastUsed: 4,
      cooldownUntil: 40_000,
    });
  });

  it("preserves an auth rotation captured by the candidate", () => {
    const finalKey = "sk-candidate";
    const agentDir = "/tmp/openclaw-auth-rollback-sk-candidate";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
    setRuntimeAuthProfileStoreSnapshot(
      snapshot("sk-candidate", 19_002).authStores[0]!.store,
      agentDir,
    );
    const candidate = snapshot("sk-candidate", 19_002);
    candidate.authStores[0]!.store.profiles["anthropic:candidate"] = {
      type: "api_key",
      provider: "anthropic",
      key: "sk-rejected-candidate",
    };
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_001);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: finalKey,
    });
    expect(
      getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["anthropic:candidate"],
    ).toBeUndefined();
  });

  it.each([
    {
      label: "candidate change",
      baselineAKey: "a-old",
      candidateAKey: "a-candidate",
      currentAKey: "a-candidate",
      currentAExternal: false,
      expectedAKey: "a-old",
    },
    {
      label: "candidate deletion",
      baselineAKey: "a-old",
      candidateAKey: null,
      currentAKey: null,
      currentAExternal: false,
      expectedAKey: "a-old",
    },
    {
      label: "triple rotation",
      baselineAKey: "a-old",
      candidateAKey: "a-candidate",
      currentAKey: "a-external",
      currentAExternal: true,
      expectedAKey: "a-external",
    },
    {
      label: "external logout",
      baselineAKey: "a-old",
      candidateAKey: "a-candidate",
      currentAKey: null,
      currentAExternal: false,
      expectedAKey: null,
    },
    {
      label: "candidate-only overwrite",
      baselineAKey: null,
      candidateAKey: "a-candidate",
      currentAKey: "a-external",
      currentAExternal: true,
      expectedAKey: "a-external",
    },
  ])(
    "resolves per-profile ownership for $label while preserving post-activation profile B",
    ({ label, baselineAKey, candidateAKey, currentAKey, currentAExternal, expectedAKey }) => {
      const agentDir = `/tmp/openclaw-auth-post-activation-${label}`;
      const profile = (provider: string, key: string) => ({
        type: "api_key" as const,
        provider,
        key,
      });
      const snapshot = (
        aKey: string | null,
        bKey: string,
        port: number,
        aExternal = false,
      ): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                ...(aKey === null ? {} : { "provider-a:default": profile("provider-a", aKey) }),
                "provider-b:default": profile("provider-b", bKey),
              },
              runtimeExternalProfileIds: aExternal ? ["provider-a:default"] : undefined,
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot(baselineAKey, "b-old", 19_001),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot(candidateAKey, "b-old", 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      setRuntimeAuthProfileStoreSnapshot(
        snapshot(currentAKey, "b-external", 19_002, currentAExternal).authStores[0]!.store,
        agentDir,
      );
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["provider-b:default"],
      });

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      const restored = getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles;
      if (expectedAKey === null) {
        expect(restored?.["provider-a:default"]).toBeUndefined();
      } else {
        expect(restored?.["provider-a:default"]).toMatchObject({ key: expectedAKey });
      }
      expect(restored?.["provider-b:default"]).toMatchObject({ key: "b-external" });
      if (currentAExternal) {
        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.runtimeExternalProfileIds).toContain(
          "provider-a:default",
        );
      }
    },
  );

  it.each([
    { label: "local override", runtimeLocalProfileIds: ["openai:default"], expected: "sk-old" },
    { label: "inherited profile", runtimeLocalProfileIds: [], expected: "sk-candidate" },
  ])("uses the effective owner token for a $label", ({ runtimeLocalProfileIds, expected }) => {
    const agentDir = `/tmp/openclaw-auth-effective-owner-${runtimeLocalProfileIds.length}`;
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
            runtimeLocalProfileIds,
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["openai:default"],
    });
    setRuntimeAuthProfileStoreSnapshot(candidate.authStores[0]!.store, agentDir);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: expected,
    });
  });

  it("invalidates a partial store when an omitted candidate owner mutates", () => {
    const agentDir = "/tmp/openclaw-auth-external-omission";
    const snapshot = (
      profiles: AuthProfileStore["profiles"],
      externalProfileIds: string[],
      port: number,
    ): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles,
            runtimeExternalProfileIds: externalProfileIds,
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    const profileX = {
      type: "api_key" as const,
      provider: "openai",
      key: "sk-external-x",
    };
    const profileY = {
      type: "api_key" as const,
      provider: "openai",
      key: "sk-external-y",
    };
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot(
        { "openai:x": profileX, "openai:y": profileY },
        ["openai:x", "openai:y"],
        19_001,
      ),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot({ "openai:y": profileY }, ["openai:y"], 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["openai:x"],
    });
    setRuntimeAuthProfileStoreSnapshot(candidate.authStores[0]!.store, agentDir);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
  });

  it.each([
    { candidateOwner: "inherited", mutateCandidateOwner: true },
    { candidateOwner: "local", mutateCandidateOwner: true },
    { candidateOwner: "inherited", mutateCandidateOwner: false },
    { candidateOwner: "local", mutateCandidateOwner: false },
  ] as const)(
    "handles baseline external to $candidateOwner with mutation=$mutateCandidateOwner",
    ({ candidateOwner, mutateCandidateOwner }) => {
      const agentDir = `/tmp/openclaw-auth-external-to-${candidateOwner}-${mutateCandidateOwner}`;
      const snapshot = (
        key: string,
        owner: "external" | "inherited" | "local",
        port: number,
      ): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:x": { type: "api_key", provider: "openai", key },
              },
              runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
              runtimeLocalProfileIds: owner === "local" ? ["openai:x"] : [],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot("sk-external-old", "external", 19_001),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot("sk-candidate", candidateOwner, 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (mutateCandidateOwner) {
        noteRuntimeAuthProfileStorePersistedMutation(
          candidateOwner === "local" ? agentDir : undefined,
          {
            credentialsChanged: true,
            stateChanged: false,
            profileIds: ["openai:x"],
          },
        );
      }
      setRuntimeAuthProfileStoreSnapshot(
        snapshot(mutateCandidateOwner ? "sk-candidate" : "sk-descendant", candidateOwner, 19_002)
          .authStores[0]!.store,
        agentDir,
      );

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (mutateCandidateOwner) {
        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
      } else {
        const restored = getRuntimeAuthProfileStoreSnapshot(agentDir);
        expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-external-old" });
        expect(restored?.runtimeExternalProfileIds).toContain("openai:x");
      }
    },
  );

  it.each(["absent", "inherited", "local"] as const)(
    "invalidates candidate external ownership after a baseline $baselineOwner mutation",
    (baselineOwner) => {
      const agentDir = `/tmp/openclaw-auth-${baselineOwner}-to-external`;
      const snapshot = (
        key: string | null,
        owner: "external" | "inherited" | "local",
        port: number,
      ): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                ...(key === null
                  ? {}
                  : { "openai:x": { type: "api_key" as const, provider: "openai", key } }),
                "anthropic:stable": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-stable",
                },
              },
              runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
              runtimeLocalProfileIds: [
                "anthropic:stable",
                ...(owner === "local" ? ["openai:x"] : []),
              ],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot(
          baselineOwner === "absent" ? null : "sk-baseline",
          baselineOwner === "local" ? "local" : "inherited",
          19_001,
        ),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot("sk-external", "external", 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      noteRuntimeAuthProfileStorePersistedMutation(
        baselineOwner === "inherited" ? undefined : agentDir,
        {
          credentialsChanged: true,
          stateChanged: false,
          profileIds: ["openai:x"],
        },
      );
      setRuntimeAuthProfileStoreSnapshot(candidate.authStores[0]!.store, agentDir);

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
    },
  );

  it.each(["absent", "inherited", "local"] as const)(
    "restores unchanged $baselineOwner ownership after a candidate external refresh",
    (baselineOwner) => {
      const agentDir = `/tmp/openclaw-auth-${baselineOwner}-external-refresh`;
      const snapshot = (
        key: string | null,
        owner: "external" | "inherited" | "local",
        port: number,
      ): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                ...(key === null
                  ? {}
                  : { "openai:x": { type: "api_key" as const, provider: "openai", key } }),
                "anthropic:stable": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-stable",
                },
              },
              runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
              runtimeLocalProfileIds: [
                "anthropic:stable",
                ...(owner === "local" ? ["openai:x"] : []),
              ],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      const baseline = snapshot(
        baselineOwner === "absent" ? null : "sk-baseline",
        baselineOwner === "local" ? "local" : "inherited",
        19_001,
      );
      activateSecretsRuntimeSnapshotState({
        snapshot: baseline,
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot("sk-external", "external", 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      setRuntimeAuthProfileStoreSnapshot(
        snapshot("sk-external-refresh", "external", 19_002).authStores[0]!.store,
        agentDir,
      );

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      const restored = getRuntimeAuthProfileStoreSnapshot(agentDir);
      if (baselineOwner === "absent") {
        expect(restored?.profiles["openai:x"]).toBeUndefined();
      } else {
        expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-baseline" });
      }
      expect(restored?.runtimeExternalProfileIds ?? []).not.toContain("openai:x");
    },
  );

  it.each([
    { candidateOwner: "local", currentOwner: "external" },
    { candidateOwner: "external", currentOwner: "local" },
  ] as const)(
    "preserves $currentOwner owner metadata when bytes equal the $candidateOwner candidate",
    ({ candidateOwner, currentOwner }) => {
      const agentDir = `/tmp/openclaw-auth-${candidateOwner}-${currentOwner}-equal-bytes`;
      const snapshot = (
        key: string,
        owner: "external" | "local",
        port: number,
      ): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:x": { type: "api_key", provider: "openai", key },
              },
              runtimeExternalProfileIds: owner === "external" ? ["openai:x"] : [],
              runtimeLocalProfileIds: owner === "local" ? ["openai:x"] : [],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot("sk-old", candidateOwner, 19_001),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot("sk-candidate", candidateOwner, 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      setRuntimeAuthProfileStoreSnapshot(
        snapshot("sk-candidate", currentOwner, 19_002).authStores[0]!.store,
        agentDir,
      );

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      const restored = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-candidate" });
      if (currentOwner === "local") {
        expect(restored?.runtimeLocalProfileIds).toContain("openai:x");
        expect(restored?.runtimeExternalProfileIds ?? []).not.toContain("openai:x");
      } else {
        expect(restored?.runtimeExternalProfileIds).toContain("openai:x");
        expect(restored?.runtimeLocalProfileIds ?? []).not.toContain("openai:x");
      }
    },
  );

  it("preserves an authoritative empty external overlay on rollback", () => {
    const agentDir = "/tmp/openclaw-auth-authoritative-empty-external";
    const snapshot = (authoritative: boolean, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {},
            runtimeExternalProfileIds: [],
            runtimeExternalProfileIdsAuthoritative: authoritative ? true : undefined,
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot(true, 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot(false, 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toMatchObject({
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("does not import rejected external authority from a selected current credential", () => {
    const agentDir = "/tmp/openclaw-auth-rejected-external-authority";
    const snapshot = (
      key: string,
      authoritative: boolean,
      port: number,
    ): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:x": { type: "api_key", provider: "openai", key },
            },
            runtimeLocalProfileIds: ["openai:x"],
            runtimeExternalProfileIds: [],
            runtimeExternalProfileIdsAuthoritative: authoritative ? true : undefined,
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", false, 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-old", true, 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    setRuntimeAuthProfileStoreSnapshot(
      snapshot("sk-current", true, 19_002).authStores[0]!.store,
      agentDir,
    );

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const restored = getRuntimeAuthProfileStoreSnapshot(agentDir);
    expect(restored?.profiles["openai:x"]).toMatchObject({ key: "sk-current" });
    expect(restored?.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
  });

  it.each([
    { current: "sk-candidate", expected: "sk-old" },
    { current: "sk-external-refresh", expected: "sk-external-refresh" },
  ])("keeps external profile ownership separate from main mutations", ({ current, expected }) => {
    const agentDir = `/tmp/openclaw-auth-external-owner-${current}`;
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:external": { type: "api_key", provider: "openai", key },
            },
            runtimeExternalProfileIds: ["openai:external"],
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      stateChanged: false,
      profileIds: ["openai:external"],
    });
    setRuntimeAuthProfileStoreSnapshot(snapshot(current, 19_002).authStores[0]!.store, agentDir);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:external"]).toMatchObject(
      {
        key: expected,
      },
    );
  });

  it("removes a rejected candidate credential when its bounded lineage was evicted", () => {
    const agentDir = "/tmp/openclaw-auth-evicted-lineage";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
              "anthropic:stable": {
                type: "api_key",
                provider: "anthropic",
                key: "sk-stable",
              },
            },
            runtimeLocalProfileIds: ["anthropic:stable", "openai:default"],
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    for (let index = 0; index < 300; index += 1) {
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: [`openai:unrelated-${index}`],
      });
    }

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
  });

  it.each(["owner", "profile"] as const)(
    "drops a changed-ref descendant after $eviction lineage eviction",
    (eviction) => {
      const root = autoCleanupTempDirs.make("openclaw-auth-evicted-ref-");
      const agentDir = path.join(root, eviction);
      fs.mkdirSync(agentDir, { recursive: true });
      const previousRef = {
        source: "env" as const,
        provider: "default",
        id: "OPENAI_API_KEY",
      };
      const candidateRef = { ...previousRef, id: "OPENAI_API_KEY_NEXT" };
      const snapshot = (
        key: string,
        keyRef: typeof previousRef,
        port: number,
      ): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:default": { type: "api_key", provider: "openai", key, keyRef },
              },
              runtimeLocalProfileIds: ["openai:default"],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      try {
        saveAuthProfileStore(
          snapshot("sk-old", previousRef, 19_001).authStores[0]!.store,
          agentDir,
        );
        activateSecretsRuntimeSnapshotState({
          snapshot: snapshot("sk-old", previousRef, 19_001),
          refreshContext: null,
          refreshHandler: null,
        });
        const previous = getActiveSecretsRuntimeSnapshot()!;
        const candidate = snapshot("sk-candidate", candidateRef, 19_002);
        expect(
          activateSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: candidate,
            expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
            refreshContext: null,
            refreshHandler: null,
          }),
        ).toBe(true);
        setRuntimeAuthProfileStoreSnapshot(
          snapshot("sk-descendant", candidateRef, 19_002).authStores[0]!.store,
          agentDir,
        );
        for (let index = 0; index < 300; index += 1) {
          noteRuntimeAuthProfileStorePersistedMutation(
            eviction === "owner" ? `/tmp/openclaw-auth-unrelated-owner-${index}` : agentDir,
            {
              credentialsChanged: true,
              stateChanged: false,
              profileIds: [`openai:unrelated-${index}`],
            },
          );
        }

        expect(
          restoreSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: previous,
            expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
            ownedSnapshot: candidate,
            refreshContext: null,
            refreshHandler: null,
          }),
        ).toBe(true);
        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles["openai:default"],
        ).toMatchObject({ keyRef: previousRef });
      } finally {
        clearSecretsRuntimeSnapshot();
        closeOpenClawAgentDatabasesForTest();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      label: "candidate-owned omission",
      mutationOwner: "none",
      profileId: "",
      stateOnly: false,
      inheritsMainProfile: false,
      inheritsMainState: false,
      expectMissing: false,
    },
    {
      label: "persisted external removal",
      mutationOwner: "custom",
      profileId: "openai:default",
      stateOnly: false,
      inheritsMainProfile: false,
      inheritsMainState: false,
      expectMissing: true,
    },
    {
      label: "state-only bookkeeping write",
      mutationOwner: "custom",
      profileId: "",
      stateOnly: true,
      inheritsMainProfile: false,
      inheritsMainState: false,
      expectMissing: true,
    },
    {
      label: "unrelated main-store write",
      mutationOwner: "main",
      profileId: "anthropic:main",
      stateOnly: false,
      inheritsMainProfile: true,
      inheritsMainState: false,
      expectMissing: false,
    },
    {
      label: "unrelated main bookkeeping write",
      mutationOwner: "main",
      profileId: "",
      stateOnly: true,
      inheritsMainProfile: false,
      inheritsMainState: false,
      expectMissing: false,
    },
    {
      label: "inherited main bookkeeping write",
      mutationOwner: "main",
      profileId: "",
      stateOnly: true,
      inheritsMainProfile: true,
      inheritsMainState: true,
      expectMissing: true,
    },
    {
      label: "related main-store write",
      mutationOwner: "main",
      profileId: "openai:default",
      stateOnly: false,
      inheritsMainProfile: true,
      inheritsMainState: false,
      expectMissing: true,
    },
  ] as const)(
    "handles whole-store $label after candidate omission",
    ({
      label,
      mutationOwner,
      profileId,
      stateOnly,
      inheritsMainProfile,
      inheritsMainState,
      expectMissing,
    }) => {
      const agentDir = `/tmp/openclaw-auth-store-removal-${label}`;
      const snapshot = (includeStore: boolean, port: number): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {},
        config: { gateway: { port } },
        authStores: includeStore
          ? [
              {
                agentDir,
                store: {
                  version: 1,
                  profiles: {
                    "openai:default": {
                      type: "api_key",
                      provider: "openai",
                      key: "sk-old",
                    },
                  },
                  runtimeLocalProfileIds: inheritsMainProfile ? [] : ["openai:default"],
                  runtimeInheritsMainState: inheritsMainState,
                },
              },
            ]
          : [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot(true, 19_001),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot(false, 19_002);
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (mutationOwner !== "none") {
        noteRuntimeAuthProfileStorePersistedMutation(
          mutationOwner === "custom" ? agentDir : undefined,
          {
            credentialsChanged: !stateOnly,
            stateChanged: stateOnly,
            profileIds: [profileId],
          },
        );
      }

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (expectMissing) {
        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
      } else {
        expect(
          getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"],
        ).toMatchObject({ key: "sk-old" });
      }
    },
  );

  it("does not resurrect a baseline external store after a new main profile is added", () => {
    const agentDir = "/tmp/openclaw-auth-external-store-omission-mutation";
    const snapshot = (includeStore: boolean, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: includeStore
        ? [
            {
              agentDir,
              store: {
                version: 1,
                profiles: {
                  "openai:x": {
                    type: "api_key",
                    provider: "openai",
                    key: "sk-external",
                  },
                },
                runtimeExternalProfileIds: ["openai:x"],
              },
            },
          ]
        : [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot(true, 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot(false, 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    noteRuntimeAuthProfileStorePersistedMutation(undefined, {
      credentialsChanged: true,
      profileSetChanged: true,
      stateChanged: false,
      profileIds: ["openai:new-main"],
    });

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
  });

  it("does not resurrect an auth store cleared after candidate activation", () => {
    const agentDir = "/tmp/openclaw-auth-post-activation-clear";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-candidate", 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    clearRuntimeAuthProfileStoreSnapshots();

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
  });

  it.each([
    { label: "retains a resolved value for the same auth-store SecretRef", changedRef: false },
    { label: "restores the predecessor when the auth-store SecretRef changed", changedRef: true },
  ])("$label", ({ changedRef }) => {
    const agentDir = `/tmp/openclaw-auth-ref-rollback-${changedRef}`;
    const previousRef = {
      source: "env" as const,
      provider: "default",
      id: "OPENAI_API_KEY",
    };
    const candidateRef = changedRef ? { ...previousRef, id: "OPENAI_API_KEY_NEXT" } : previousRef;
    const snapshot = (
      key: string,
      keyRef: typeof previousRef,
      port: number,
    ): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key, keyRef },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", previousRef, 19_001),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot("sk-candidate", candidateRef, 19_002);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: snapshot("sk-refreshed", candidateRef, 19_002),
        expectedRevision: candidateRevision,
        refreshContext: null,
        refreshHandler: null,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        expectedRevision: candidateRevision,
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: changedRef ? "sk-old" : "sk-refreshed",
      keyRef: changedRef ? previousRef : candidateRef,
    });
  });

  it("preserves live credentials when the captured predecessor is stale", () => {
    const agentDir = "/tmp/openclaw-auth-stale-predecessor-rollback";
    const snapshot = (key: string, port: number): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {},
      config: { gateway: { port } },
      authStores: [
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "openai:default": { type: "api_key", provider: "openai", key },
            },
          },
        },
      ],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot("sk-old", 19_011),
      refreshContext: null,
      refreshHandler: null,
    });
    setRuntimeAuthProfileStoreSnapshot(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-live" },
        },
      },
      agentDir,
    );
    const previous = getActiveSecretsRuntimeSnapshot();
    const previousRevision = getActiveSecretsRuntimeSnapshotRevision();
    const candidate = snapshot("sk-live", 19_012);
    expect(previous).not.toBeNull();
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: previousRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous!,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        ownedSnapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_011);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "sk-live",
    });
  });

  it.each([
    {
      label: "retains a provider-auth descendant for the same SecretRef",
      candidateRefId: "OPENAI_API_KEY",
      expectedKey: "sk-refreshed",
    },
    {
      label: "retains a provider-auth descendant for matching env shorthand",
      candidateRefId: "OPENAI_API_KEY",
      expectedKey: "sk-refreshed",
      shorthand: true,
    },
    {
      label: "restores the predecessor value when the candidate changed its SecretRef",
      candidateRefId: "OPENAI_API_KEY_NEXT",
      expectedKey: "sk-old",
    },
  ])("$label", ({ candidateRefId, expectedKey, shorthand }) => {
    const previousKeyRef = {
      source: "env" as const,
      provider: "default",
      id: "OPENAI_API_KEY",
    };
    const previousKeyInput = shorthand ? "$OPENAI_API_KEY" : previousKeyRef;
    const candidateKeyInput = shorthand
      ? `$${candidateRefId}`
      : { ...previousKeyRef, id: candidateRefId };
    const snapshot = (params: {
      sourcePort: number;
      runtimePort: number;
      apiKey: string;
      keyRef: string | typeof previousKeyRef;
    }): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: {
        gateway: { port: params.sourcePort },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: params.keyRef,
              models: [],
            },
          },
        },
      },
      config: {
        gateway: { port: params.runtimePort },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: params.apiKey,
              models: [],
            },
          },
        },
      },
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: snapshot({
        sourcePort: 19_021,
        runtimePort: 19_021,
        apiKey: "sk-old",
        keyRef: previousKeyInput,
      }),
      refreshContext: null,
      refreshHandler: null,
    });
    const previous = getActiveSecretsRuntimeSnapshot()!;
    const candidate = snapshot({
      sourcePort: 19_022,
      runtimePort: 19_022,
      apiKey: "sk-candidate",
      keyRef: candidateKeyInput,
    });
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: candidate,
        expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
    const providerRefresh = snapshot({
      sourcePort: 19_022,
      runtimePort: 19_022,
      apiKey: "sk-refreshed",
      keyRef: candidateKeyInput,
    });
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: providerRefresh,
        expectedRevision: candidateRevision,
        refreshContext: null,
        refreshHandler: null,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: previous,
        ownedSnapshot: candidate,
        expectedRevision: candidateRevision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19_021);
    expect(getActiveSecretsRuntimeSnapshot()?.config.models?.providers?.openai?.apiKey).toBe(
      expectedKey,
    );
  });

  it.each([
    {
      evictLineage: true,
      label: "provider definition with evicted lineage",
      keyRef: { source: "file", provider: "vault", id: "openai" } satisfies SecretRef,
      previousSourceConfig: {
        secrets: {
          providers: { vault: { source: "file", path: "/tmp/old-secrets.json" } },
        },
      } satisfies OpenClawConfig,
      candidateSourceConfig: {
        secrets: {
          providers: { vault: { source: "file", path: "/tmp/rejected-secrets.json" } },
        },
      } satisfies OpenClawConfig,
    },
    {
      evictLineage: false,
      label: "plugin integration owner",
      keyRef: { source: "exec", provider: "plugin-vault", id: "openai" } satisfies SecretRef,
      previousSourceConfig: {
        secrets: {
          providers: {
            "plugin-vault": {
              source: "exec",
              pluginIntegration: { pluginId: "secret-plugin", integrationId: "vault" },
            },
          },
        },
        plugins: { entries: { "secret-plugin": { enabled: true } } },
      } satisfies OpenClawConfig,
      candidateSourceConfig: {
        secrets: {
          providers: {
            "plugin-vault": {
              source: "exec",
              pluginIntegration: { pluginId: "secret-plugin", integrationId: "vault" },
            },
          },
        },
        plugins: { entries: { "secret-plugin": { enabled: false } } },
      } satisfies OpenClawConfig,
    },
  ] as Array<{
    evictLineage: boolean;
    label: string;
    keyRef: SecretRef;
    previousSourceConfig: OpenClawConfig;
    candidateSourceConfig: OpenClawConfig;
  }>)(
    "restores resolved values when a same-ref $label was rejected",
    ({ keyRef, previousSourceConfig, candidateSourceConfig, evictLineage }) => {
      const agentDir = `/tmp/openclaw-auth-provider-dependency-${keyRef.provider}`;
      const snapshot = (params: {
        sourceConfig: OpenClawConfig;
        apiKey: string;
        port: number;
      }): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {
          ...params.sourceConfig,
          gateway: { port: params.port },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: keyRef,
                models: [],
              },
            },
          },
        },
        config: {
          ...params.sourceConfig,
          gateway: { port: params.port },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: params.apiKey,
                models: [],
              },
            },
          },
        },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:default": {
                  type: "api_key",
                  provider: "openai",
                  keyRef,
                  key: params.apiKey,
                },
              },
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot({ sourceConfig: previousSourceConfig, apiKey: "sk-old", port: 19_031 }),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot({
        sourceConfig: candidateSourceConfig,
        apiKey: "sk-candidate",
        port: 19_032,
      });
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (evictLineage) {
        for (let index = 0; index < 300; index += 1) {
          noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
            credentialsChanged: true,
            stateChanged: false,
            profileIds: [`openai:unrelated-${index}`],
          });
        }
      }
      const candidateRevision = getActiveSecretsRuntimeSnapshotRevision();
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: snapshot({
            sourceConfig: candidateSourceConfig,
            apiKey: "sk-refreshed",
            port: 19_032,
          }),
          expectedRevision: candidateRevision,
          refreshContext: null,
          refreshHandler: null,
          preserveActivationLineage: true,
        }),
      ).toBe(true);

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          ownedSnapshot: candidate,
          expectedRevision: candidateRevision,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      const restored = getActiveSecretsRuntimeSnapshot();
      expect(restored?.sourceConfig).toMatchObject(previousSourceConfig);
      expect(restored?.config.models?.providers?.openai?.apiKey).toBe("sk-old");
      if (evictLineage) {
        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
      } else {
        expect(
          getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"],
        ).toMatchObject({
          key: "sk-old",
          keyRef,
        });
      }
    },
  );

  it.each([
    { capturedOwner: "local", currentOwner: "inherited", label: "local delete" },
    { capturedOwner: "inherited", currentOwner: "local", label: "local upsert" },
    { capturedOwner: "local", currentOwner: "local", label: "same-owner local update" },
  ] as const)(
    "invalidates a same-ref provider change after a durable $label",
    ({ capturedOwner, currentOwner }) => {
      const agentDir = `/tmp/openclaw-auth-provider-owner-${capturedOwner}-${currentOwner}`;
      const keyRef = {
        source: "file" as const,
        provider: "vault",
        id: "openai",
      };
      const snapshot = (params: {
        key: string;
        owner: "inherited" | "local";
        providerPath: string;
        port: number;
      }): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {
          gateway: { port: params.port },
          secrets: {
            providers: { vault: { source: "file", path: params.providerPath } },
          },
        },
        config: { gateway: { port: params.port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:default": {
                  type: "api_key",
                  provider: "openai",
                  key: params.key,
                  keyRef,
                },
              },
              runtimeLocalProfileIds: params.owner === "local" ? ["openai:default"] : [],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot({
          key: "sk-old",
          owner: capturedOwner,
          providerPath: "/tmp/old-secrets.json",
          port: 19_041,
        }),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot({
        key: "sk-candidate",
        owner: capturedOwner,
        providerPath: "/tmp/rejected-secrets.json",
        port: 19_042,
      });
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:default"],
      });
      setRuntimeAuthProfileStoreSnapshot(
        snapshot({
          key: "sk-durable",
          owner: currentOwner,
          providerPath: "/tmp/rejected-secrets.json",
          port: 19_042,
        }).authStores[0]!.store,
        agentDir,
      );

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
    },
  );

  it.each([
    { affectedProvider: true, currentProvider: "vault" },
    { affectedProvider: false, currentProvider: "stable" },
  ] as const)(
    "handles a durable ref-id update through $currentProvider with affected=$affectedProvider",
    ({ affectedProvider, currentProvider }) => {
      const agentDir = `/tmp/openclaw-auth-provider-ref-update-${currentProvider}`;
      const previousSourceConfig = {
        secrets: {
          providers: {
            stable: { source: "file" as const, path: "/tmp/stable-secrets.json" },
            vault: { source: "file" as const, path: "/tmp/old-secrets.json" },
          },
        },
      };
      const candidateSourceConfig = {
        secrets: {
          providers: {
            stable: { source: "file" as const, path: "/tmp/stable-secrets.json" },
            vault: { source: "file" as const, path: "/tmp/rejected-secrets.json" },
          },
        },
      };
      const previousRef = {
        source: "file" as const,
        provider: "vault",
        id: "openai-a",
      };
      const currentRef = {
        source: "file" as const,
        provider: currentProvider,
        id: "openai-b",
      };
      const snapshot = (params: {
        key: string;
        keyRef: SecretRef;
        port: number;
        sourceConfig: OpenClawConfig;
      }): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: { ...params.sourceConfig, gateway: { port: params.port } },
        config: { gateway: { port: params.port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "openai:default": {
                  type: "api_key",
                  provider: "openai",
                  key: params.key,
                  keyRef: params.keyRef,
                },
              },
              runtimeLocalProfileIds: ["openai:default"],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot({
          key: "sk-old",
          keyRef: previousRef,
          port: 19_051,
          sourceConfig: previousSourceConfig,
        }),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot({
        key: "sk-candidate",
        keyRef: previousRef,
        port: 19_052,
        sourceConfig: candidateSourceConfig,
      });
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:default"],
      });
      setRuntimeAuthProfileStoreSnapshot(
        snapshot({
          key: "sk-durable",
          keyRef: currentRef,
          port: 19_052,
          sourceConfig: candidateSourceConfig,
        }).authStores[0]!.store,
        agentDir,
      );

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (affectedProvider) {
        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
      } else {
        expect(
          getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"],
        ).toMatchObject({ key: "sk-durable", keyRef: currentRef });
      }
    },
  );

  it.each(["external", "local"] as const)(
    "invalidates an absent-profile $currentOwner upsert under a rejected provider",
    (currentOwner) => {
      const agentDir = `/tmp/openclaw-auth-provider-absent-upsert-${currentOwner}`;
      const snapshot = (params: {
        includeProfile: boolean;
        providerPath: string;
        port: number;
      }): PreparedSecretsRuntimeSnapshot => ({
        sourceConfig: {
          gateway: { port: params.port },
          secrets: {
            providers: { vault: { source: "file", path: params.providerPath } },
          },
        },
        config: { gateway: { port: params.port } },
        authStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "anthropic:stable": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-stable",
                },
                ...(params.includeProfile
                  ? {
                      "openai:default": {
                        type: "api_key" as const,
                        provider: "openai",
                        key: "sk-current",
                        keyRef: {
                          source: "file" as const,
                          provider: "vault",
                          id: "openai-b",
                        },
                      },
                    }
                  : {}),
              },
              runtimeExternalProfileIds:
                params.includeProfile && currentOwner === "external" ? ["openai:default"] : [],
              runtimeLocalProfileIds: [
                "anthropic:stable",
                ...(params.includeProfile && currentOwner === "local" ? ["openai:default"] : []),
              ],
            },
          },
        ],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      activateSecretsRuntimeSnapshotState({
        snapshot: snapshot({
          includeProfile: false,
          providerPath: "/tmp/old-secrets.json",
          port: 19_061,
        }),
        refreshContext: null,
        refreshHandler: null,
      });
      const previous = getActiveSecretsRuntimeSnapshot()!;
      const candidate = snapshot({
        includeProfile: false,
        providerPath: "/tmp/rejected-secrets.json",
        port: 19_062,
      });
      expect(
        activateSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: candidate,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      if (currentOwner === "local") {
        noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
          credentialsChanged: true,
          profileSetChanged: true,
          stateChanged: false,
          profileIds: ["openai:default"],
        });
      }
      setRuntimeAuthProfileStoreSnapshot(
        snapshot({
          includeProfile: true,
          providerPath: "/tmp/rejected-secrets.json",
          port: 19_062,
        }).authStores[0]!.store,
        agentDir,
      );

      expect(
        restoreSecretsRuntimeSnapshotStateIfCurrent({
          snapshot: previous,
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          ownedSnapshot: candidate,
          refreshContext: null,
          refreshHandler: null,
        }),
      ).toBe(true);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
