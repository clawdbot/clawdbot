/**
 * Regression coverage for process-local auth profile snapshots.
 * Verifies snapshots are cloned and isolated across agent-specific stores.
 */

import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as authProfileClone from "./clone.js";
import {
  getPreparedRuntimeAuthMaterializations,
  recordRuntimeAuthMaterialization,
  registerRuntimeAuthMaterializationMutationListener,
  revokeRuntimeAuthMaterializations,
} from "./runtime-materializations.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore,
  clearRuntimeAuthProfileStoreSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreCredentialsRevision,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  noteRuntimeAuthProfileStorePersistedMutation,
  registerRuntimeAuthProfileStoreMutationListener,
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { testing } from "./runtime-snapshots.test-support.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

function createStore(access: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + 60_000,
        accountId: "acct-1",
      },
    },
    order: {
      openai: ["openai:default"],
    },
    usageStats: {
      "openai:default": {
        lastUsed: 1,
      },
    },
  };
}

function expectOpenAICodexSnapshotCredential(
  store: AuthProfileStore | undefined,
  params: { access: string; refresh?: string },
) {
  const credential = store?.profiles["openai:default"];
  expect(credential?.type).toBe("oauth");
  if (credential?.type !== "oauth") {
    throw new Error("Expected OpenAI Codex OAuth credential snapshot");
  }
  expect(credential.provider).toBe("openai");
  expect(credential.access).toBe(params.access);
  if (params.refresh) {
    expect(credential.refresh).toBe(params.refresh);
  }
}

describe("runtime auth profile snapshots", () => {
  it("carries the canonical database identity through snapshot enumeration", () => {
    const databasePath = "/tmp/openclaw-auth-runtime-enumeration/custom.sqlite";
    const store = createStore("enumerated");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        databasePath,
        agentDir: "/tmp/projected-agent-dir-must-not-own-identity",
        store,
      },
    ]);
    try {
      expect(listOwnedRuntimeAuthProfileStoreSnapshots()).toMatchObject([
        {
          databasePath,
          agentDir: path.dirname(databasePath),
          store,
        },
      ]);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("marks default-owner materializations as inherited mutations", () => {
    const listener = vi.fn();
    const unregister = registerRuntimeAuthMaterializationMutationListener(listener);
    try {
      recordRuntimeAuthMaterialization({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
      });

      expect(listener).toHaveBeenCalledWith({
        affectsInheritedStores: true,
      });
    } finally {
      unregister();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("publishes successful-auth facts without impersonating credential rotation", () => {
    const agentDir = "/tmp/openclaw-auth-runtime-materialized";
    const pluginStoreListener = vi.fn();
    const materializationListener = vi.fn();
    setRuntimeAuthProfileStoreSnapshot(createStore("materialized"), agentDir);
    const unregisterStore = registerRuntimeAuthProfileStoreMutationListener(pluginStoreListener);
    const unregisterMaterialization =
      registerRuntimeAuthMaterializationMutationListener(materializationListener);
    try {
      const materialization = {
        agentDir,
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
        authProfileId: "openai:default",
      } as const;
      expect(recordRuntimeAuthMaterialization(materialization)).toBe(true);
      expect(recordRuntimeAuthMaterialization(materialization)).toBe(false);
      expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
        {
          provider: "openai",
          modelId: "gpt-5.4",
          modelApi: "openai-chatgpt-responses",
          modelBaseUrl: "https://chatgpt.com/backend-api/codex",
          requestTransportOverrides: "none",
          authMode: "oauth",
          runtimeOwnerId: "codex",
          authProfileId: "openai:default",
        },
      ]);
      const sibling = { ...materialization, modelId: "gpt-5.5" };
      const distinctOwner = { ...materialization, runtimeOwnerId: "other-harness" };
      recordRuntimeAuthMaterialization(sibling);
      recordRuntimeAuthMaterialization(distinctOwner);
      expect(
        revokeRuntimeAuthMaterializations({
          agentDir,
          provider: "openai",
          runtimeOwnerId: "codex",
        }),
      ).toBe(true);
      expect(
        revokeRuntimeAuthMaterializations({
          agentDir,
          provider: "openai",
          runtimeOwnerId: "codex",
        }),
      ).toBe(false);
      expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
        expect.objectContaining({ runtimeOwnerId: "other-harness", modelId: "gpt-5.4" }),
      ]);
      expect(materializationListener).toHaveBeenCalledTimes(4);
      expect(pluginStoreListener).not.toHaveBeenCalled();

      recordRuntimeAuthMaterialization(materialization);

      setRuntimeAuthProfileStoreSnapshot(createStore("replaced"), agentDir);
      expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([]);
      expect(pluginStoreListener).toHaveBeenCalledOnce();
    } finally {
      unregisterMaterialization();
      unregisterStore();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("notifies listeners only when credential ownership changes", () => {
    const agentDir = "/tmp/openclaw-auth-runtime-listener";
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    try {
      const store = createStore("listener");
      setRuntimeAuthProfileStoreSnapshot(store, agentDir);
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...store,
          usageStats: { "openai:default": { lastUsed: 2 } },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshotCore(agentDir);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenNthCalledWith(1, {
        agentDir,
        affectsInheritedStores: false,
        profileSetChanged: true,
      });
      expect(listener).toHaveBeenNthCalledWith(2, {
        agentDir,
        affectsInheritedStores: false,
        profileSetChanged: true,
      });
    } finally {
      unregister();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("notifies when provider credential order changes", () => {
    const agentDir = "/tmp/openclaw-auth-runtime-order";
    const store = createStore("order");
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            ...store,
            order: { openai: [] },
          },
        },
      ]);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({
        affectsInheritedStores: true,
        profileSetChanged: false,
      });
    } finally {
      unregister();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("notifies when identical external credentials change from CLI to plugin ownership", () => {
    const agentDir = "/tmp/openclaw-auth-runtime-external-owner";
    const store: RuntimeAuthProfileStore = {
      ...createStore("same-credential"),
      runtimeExternalProfileIds: ["openai:default"],
      runtimeExternalCliProfileIds: ["openai:default"],
    };
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    try {
      const pluginOwned: RuntimeAuthProfileStore = {
        ...store,
        runtimeExternalCliProfileIds: undefined,
      };
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: pluginOwned,
        },
      ]);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({
        affectsInheritedStores: true,
        profileSetChanged: false,
      });
    } finally {
      unregister();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("notifies when an empty runtime snapshot starts or stops shadowing persisted auth", () => {
    const agentDir = "/tmp/openclaw-auth-runtime-empty-owner";
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    const emptyStore: AuthProfileStore = { version: 1, profiles: {} };
    try {
      setRuntimeAuthProfileStoreSnapshot(emptyStore, agentDir);
      setRuntimeAuthProfileStoreSnapshot(emptyStore, agentDir);
      clearRuntimeAuthProfileStoreSnapshotCore(agentDir);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenNthCalledWith(1, {
        agentDir,
        affectsInheritedStores: false,
        profileSetChanged: false,
      });
      expect(listener).toHaveBeenNthCalledWith(2, {
        agentDir,
        affectsInheritedStores: false,
        profileSetChanged: false,
      });
    } finally {
      unregister();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("advances credential revision without coupling to usage bookkeeping", () => {
    const initialRevision = getRuntimeAuthProfileStoreCredentialsRevision();
    const store = createStore("set");
    setRuntimeAuthProfileStoreSnapshot(store);
    expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(initialRevision + 1);

    setRuntimeAuthProfileStoreSnapshot({
      ...store,
      usageStats: { "openai:default": { lastUsed: 2 } },
    });
    expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(initialRevision + 1);

    clearRuntimeAuthProfileStoreSnapshots();
    expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(initialRevision + 2);
  });

  it("isolates set/get/replace snapshot mutations without structuredClone", () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    const agentDir = "/tmp/openclaw-auth-runtime-snapshot-agent";
    try {
      const stored = createStore("access-1");
      setRuntimeAuthProfileStoreSnapshot(stored, agentDir);
      expectDefined(
        stored.profiles["openai:default"],
        'stored.profiles["openai:default"] test invariant',
      ).provider = "mutated";
      expectDefined(stored.order?.openai, "stored OpenAI profile order").push("mutated");

      const first = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
      expectOpenAICodexSnapshotCredential(first, { access: "access-1" });
      expect(first?.order?.["openai"]).toEqual(["openai:default"]);

      const firstSnapshot = expectDefined(first, "first auth profile snapshot");
      expectDefined(firstSnapshot.profiles["openai:default"], "first OpenAI profile").provider =
        "mutated-again";
      expectDefined(
        firstSnapshot.usageStats?.["openai:default"],
        "first OpenAI usage stats",
      ).lastUsed = 99;

      const second = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
      expectOpenAICodexSnapshotCredential(second, { access: "access-1" });
      expect(second?.usageStats?.["openai:default"]?.lastUsed).toBe(1);

      const replacement = createStore("access-2");
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: replacement }]);
      const replacementCredential = replacement.profiles["openai:default"];
      expect(replacementCredential?.type).toBe("oauth");
      if (replacementCredential?.type === "oauth") {
        replacementCredential.access = "mutated-replacement";
      }

      const replaced = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
      expectOpenAICodexSnapshotCredential(replaced, {
        access: "access-2",
        refresh: "refresh-access-2",
      });
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("merges inherited and agent prepared stores without persisted fallback", () => {
    const inheritedAuthDir = "/tmp/openclaw-auth-runtime-inherited";
    const agentDir = "/tmp/openclaw-auth-runtime-agent";
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...createStore("inherited"),
          profiles: {
            ...createStore("inherited").profiles,
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "inherited-key",
            },
          },
        },
        inheritedAuthDir,
      );
      setRuntimeAuthProfileStoreSnapshot(createStore("agent"), agentDir);

      const prepared = getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir, inheritedAuthDir);

      expectOpenAICodexSnapshotCredential(prepared, { access: "agent" });
      expect(prepared?.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "inherited-key",
      });
      expect(
        getPreparedRuntimeAuthProfileStoreSnapshotCore(
          "/tmp/openclaw-auth-runtime-missing",
          "/tmp/openclaw-auth-runtime-also-missing",
        ),
      ).toBeUndefined();
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("copies a prepared same-owner snapshot only once and keeps the result isolated", () => {
    const agentDir = "/tmp/openclaw-auth-prepared-same-owner";
    const store = createStore("prepared");
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const clone = vi.spyOn(authProfileClone, "cloneAuthProfileStore");
    try {
      const prepared = expectDefined(
        getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir, agentDir),
        "prepared same-owner snapshot",
      );
      expect(prepared).toMatchObject(store);
      expect(clone.mock.calls.length).toBeLessThanOrEqual(1);
      expectDefined(prepared.order?.openai, "prepared profile order").push("mutated");
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.order?.openai).toEqual([
        "openai:default",
      ]);
    } finally {
      clone.mockRestore();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it.each(["present", "empty", "missing"] as const)(
    "resolves omitted-agent preparation with a %s shared snapshot",
    (shared) => {
      const inheritedAuthDir = "/tmp/openclaw-auth-prepared-omitted-agent";
      const inherited = createStore("inherited");
      const requested = shared === "empty" ? { version: 1, profiles: {} } : createStore("shared");
      try {
        setRuntimeAuthProfileStoreSnapshot(inherited, inheritedAuthDir);
        if (shared !== "missing") {
          setRuntimeAuthProfileStoreSnapshot(requested);
        }
        expect(getPreparedRuntimeAuthProfileStoreSnapshotCore(undefined, inheritedAuthDir)).toEqual(
          shared === "missing" ? inherited : requested,
        );
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
      }
    },
  );

  it("clears one agent snapshot without disturbing other stores", () => {
    const firstAgentDir = "/tmp/openclaw-auth-runtime-snapshot-first";
    const secondAgentDir = "/tmp/openclaw-auth-runtime-snapshot-second";
    try {
      setRuntimeAuthProfileStoreSnapshot(createStore("main"));
      setRuntimeAuthProfileStoreSnapshot(createStore("first"), firstAgentDir);
      setRuntimeAuthProfileStoreSnapshot(createStore("second"), secondAgentDir);

      expect(clearRuntimeAuthProfileStoreSnapshotCore(firstAgentDir)).toBe(true);
      expect(getRuntimeAuthProfileStoreSnapshotCore(firstAgentDir)).toBeUndefined();
      expectOpenAICodexSnapshotCredential(getRuntimeAuthProfileStoreSnapshotCore(), {
        access: "main",
      });
      expectOpenAICodexSnapshotCredential(getRuntimeAuthProfileStoreSnapshotCore(secondAgentDir), {
        access: "second",
      });
      expect(clearRuntimeAuthProfileStoreSnapshotCore(firstAgentDir)).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("bounds persisted mutation lineage by owner and profile", () => {
    for (let index = 0; index <= testing.MAX_PERSISTED_MUTATION_OWNERS; index += 1) {
      noteRuntimeAuthProfileStorePersistedMutation(`/tmp/openclaw-mutation-owner-${index}`, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["openai:default"],
      });
    }
    for (let index = 0; index <= testing.MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER; index += 1) {
      noteRuntimeAuthProfileStorePersistedMutation("/tmp/openclaw-mutation-profile-owner", {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: [`openai:${index}`],
      });
    }

    const counts = testing.getPersistedMutationRecordCounts();
    expect(counts.owners).toBeLessThanOrEqual(testing.MAX_PERSISTED_MUTATION_OWNERS);
    expect(counts.profiles).toBeLessThanOrEqual(testing.MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER);
    testing.resetPersistedMutationLineage();
  });
});
