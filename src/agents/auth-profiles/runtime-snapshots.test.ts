import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import type { AuthProfileStore } from "./types.js";

function createStore(access: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + 60_000,
        accountId: "acct-1",
      },
    },
    order: {
      "openai-codex": ["openai-codex:default"],
    },
    usageStats: {
      "openai-codex:default": {
        lastUsed: 1,
      },
    },
  };
}

describe("runtime auth profile snapshots", () => {
  it("isolates set/get/replace snapshot mutations without structuredClone", () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    const agentDir = "/tmp/openclaw-auth-runtime-snapshot-agent";
    try {
      const stored = createStore("access-1");
      setRuntimeAuthProfileStoreSnapshot(stored, agentDir);
      stored.profiles["openai-codex:default"].provider = "mutated";
      stored.order!["openai-codex"].push("mutated");

      const first = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(first?.profiles["openai-codex:default"]).toMatchObject({
        provider: "openai-codex",
        access: "access-1",
      });
      expect(first?.order?.["openai-codex"]).toEqual(["openai-codex:default"]);

      first!.profiles["openai-codex:default"].provider = "mutated-again";
      first!.usageStats!["openai-codex:default"].lastUsed = 99;

      const second = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(second?.profiles["openai-codex:default"]).toMatchObject({
        provider: "openai-codex",
        access: "access-1",
      });
      expect(second?.usageStats?.["openai-codex:default"]?.lastUsed).toBe(1);

      const replacement = createStore("access-2");
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: replacement }]);
      const replacementCredential = replacement.profiles["openai-codex:default"];
      expect(replacementCredential?.type).toBe("oauth");
      if (replacementCredential?.type === "oauth") {
        replacementCredential.access = "mutated-replacement";
      }

      const replaced = getRuntimeAuthProfileStoreSnapshot(agentDir);
      expect(replaced?.profiles["openai-codex:default"]).toMatchObject({
        access: "access-2",
        refresh: "refresh-access-2",
      });
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });
});
