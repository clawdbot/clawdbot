/**
 * Regression coverage for process-local auth profile snapshots.
 * Verifies snapshots are cloned and isolated across agent-specific stores.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshot,
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreCredentialsRevision,
  noteRuntimeAuthProfileStorePersistedMutation,
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { testing } from "./runtime-snapshots.test-support.js";
import type { AuthProfileStore } from "./types.js";

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

      const first = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expectOpenAICodexSnapshotCredential(first, { access: "access-1" });
      expect(first?.order?.["openai"]).toEqual(["openai:default"]);

      const firstSnapshot = expectDefined(first, "first auth profile snapshot");
      expectDefined(firstSnapshot.profiles["openai:default"], "first OpenAI profile").provider =
        "mutated-again";
      expectDefined(
        firstSnapshot.usageStats?.["openai:default"],
        "first OpenAI usage stats",
      ).lastUsed = 99;

      const second = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expectOpenAICodexSnapshotCredential(second, { access: "access-1" });
      expect(second?.usageStats?.["openai:default"]?.lastUsed).toBe(1);

      const replacement = createStore("access-2");
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: replacement }]);
      const replacementCredential = replacement.profiles["openai:default"];
      expect(replacementCredential?.type).toBe("oauth");
      if (replacementCredential?.type === "oauth") {
        replacementCredential.access = "mutated-replacement";
      }

      const replaced = getRuntimeAuthProfileStoreSnapshot(agentDir);
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

  it("clears one agent snapshot without disturbing other stores", () => {
    const firstAgentDir = "/tmp/openclaw-auth-runtime-snapshot-first";
    const secondAgentDir = "/tmp/openclaw-auth-runtime-snapshot-second";
    try {
      setRuntimeAuthProfileStoreSnapshot(createStore("main"));
      setRuntimeAuthProfileStoreSnapshot(createStore("first"), firstAgentDir);
      setRuntimeAuthProfileStoreSnapshot(createStore("second"), secondAgentDir);

      expect(clearRuntimeAuthProfileStoreSnapshot(firstAgentDir)).toBe(true);
      expect(getRuntimeAuthProfileStoreSnapshot(firstAgentDir)).toBeUndefined();
      expectOpenAICodexSnapshotCredential(getRuntimeAuthProfileStoreSnapshot(), { access: "main" });
      expectOpenAICodexSnapshotCredential(getRuntimeAuthProfileStoreSnapshot(secondAgentDir), {
        access: "second",
      });
      expect(clearRuntimeAuthProfileStoreSnapshot(firstAgentDir)).toBe(false);
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
