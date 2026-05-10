import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function withAuthProfileMode(mode: "api_key" | "aws-sdk" | "oauth" | "token"): OpenClawConfig {
  return {
    auth: {
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          mode,
        },
      },
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as OpenClawConfig;
}

describe("secrets runtime oauth auth-profile SecretRef policy", () => {
  it("fails startup snapshot when oauth mode profile uses token SecretRef", async () => {
    const store = loadAuthStoreWithProfiles({
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
      },
    });

    await expect(
      prepareSecretsRuntimeSnapshot({
        config: withAuthProfileMode("oauth"),
        env: { ANTHROPIC_TOKEN: "token-value" } as NodeJS.ProcessEnv,
        loadAuthStore: () => store,
        loadablePluginOrigins: new Map(),
        agentDirs: ["/tmp/openclaw-secrets-runtime-main"],
      }),
    ).rejects.toThrow(/OAuth \+ SecretRef is not supported/i);
  });

  it("keeps token SecretRef support when the profile mode is token", async () => {
    const store = loadAuthStoreWithProfiles({
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: withAuthProfileMode("token"),
      env: { ANTHROPIC_TOKEN: "token-value" } as NodeJS.ProcessEnv,
      loadAuthStore: () => store,
      loadablePluginOrigins: new Map(),
      agentDirs: ["/tmp/openclaw-secrets-runtime-main"],
    });

    const resolved = snapshot.authStores[0]?.store.profiles["anthropic:default"];
    expect(resolved?.type).toBe("token");
    if (resolved?.type !== "token") {
      throw new Error("expected token auth profile");
    }
    expect(resolved?.token).toBe("token-value");
  });
});
