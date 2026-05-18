import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { legacyOAuthSidecarTestUtils } from "./legacy-oauth-sidecar.js";
import { resolveAuthStorePath } from "./paths.js";
import { coercePersistedAuthProfileStore, loadPersistedAuthProfileStore } from "./persisted.js";

function withEnvValue(key: string, value: string | undefined): () => void {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return () => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  };
}

describe("persisted auth profile boundary", () => {
  it("normalizes malformed persisted credentials and state before runtime use", () => {
    const store = coercePersistedAuthProfileStore({
      version: "not-a-version",
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: " OpenAI ",
          key: 42,
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123", bad: 123 },
          copyToAgents: "yes",
          email: ["wrong"],
          displayName: "Work",
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          token: ["wrong"],
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: "tomorrow",
        },
        "codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: ["wrong"],
          refresh: "refresh-token",
          expires: "later",
          oauthRef: {
            source: "openclaw-credentials",
            provider: "openai-codex",
            id: "not-a-secret-id",
          },
        },
        "broken:array": [],
      },
      order: {
        OpenAI: [" openai:default ", 5, ""],
        minimax: "wrong",
      },
      lastGood: {
        OpenAI: " openai:default ",
        minimax: 5,
      },
      usageStats: {
        "openai:default": {
          cooldownUntil: "later",
          disabledUntil: 123,
          disabledReason: "billing",
          failureCounts: {
            billing: 2,
            nope: 4,
          },
        },
        "minimax:default": "wrong",
      },
    });

    expect(store).toMatchObject({
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123" },
          displayName: "Work",
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: 0,
        },
        "codex:default": {
          type: "oauth",
          provider: "openai-codex",
          refresh: "refresh-token",
          expires: 0,
        },
      },
      order: {
        openai: ["openai:default"],
      },
      lastGood: {
        openai: "openai:default",
      },
      usageStats: {
        "openai:default": {
          disabledUntil: 123,
          disabledReason: "billing",
          failureCounts: { billing: 2 },
        },
      },
    });
    expect(store?.profiles["broken:array"]).toBeUndefined();
    expect(store?.profiles["openai:default"]).not.toHaveProperty("key");
    expect(store?.profiles["openai:default"]).not.toHaveProperty("copyToAgents");
    expect(store?.profiles["codex:default"]).not.toHaveProperty("oauthRef");
  });

  it("rehydrates legacy oauthRef sidecars read-only for upgraded Codex OAuth users", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-oauthref-runtime-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const restoreStateDir = withEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const restoreOAuthDir = withEnvValue("OPENCLAW_OAUTH_DIR", undefined);
    const restoreSecretKey = withEnvValue("OPENCLAW_AUTH_PROFILE_SECRET_KEY", "legacy-seed");
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const ref = {
        source: "openclaw-credentials" as const,
        provider: "openai-codex" as const,
        id: "0123456789abcdef0123456789abcdef",
      };
      fs.writeFileSync(
        resolveAuthStorePath(agentDir),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                expires: 123456,
                accountId: "acct-legacy",
                chatgptPlanType: "plus",
                oauthRef: ref,
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const sidecarPath = path.join(resolveOAuthDir(), "auth-profiles", `${ref.id}.json`);
      fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
      fs.writeFileSync(
        sidecarPath,
        `${JSON.stringify(
          {
            version: 1,
            profileId,
            provider: "openai-codex",
            encrypted: legacyOAuthSidecarTestUtils.encryptLegacyOAuthMaterial({
              ref,
              profileId,
              provider: "openai-codex",
              seed: "legacy-seed",
              material: {
                access: "legacy-access-token",
                refresh: "legacy-refresh-token",
                idToken: "legacy-id-token",
              },
            }),
          },
          null,
          2,
        )}\n`,
      );

      const unresolved = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
      expect(unresolved).not.toHaveProperty("access");
      expect(unresolved).not.toHaveProperty("refresh");
      expect(unresolved).not.toHaveProperty("idToken");

      const credential = loadPersistedAuthProfileStore(agentDir, {
        resolveLegacyOAuthSidecars: true,
      })?.profiles[profileId];
      expect(credential).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "legacy-access-token",
        refresh: "legacy-refresh-token",
        idToken: "legacy-id-token",
        expires: 123456,
        accountId: "acct-legacy",
        chatgptPlanType: "plus",
      });
      expect(credential).not.toHaveProperty("oauthRef");
    } finally {
      restoreSecretKey();
      restoreOAuthDir();
      restoreStateDir();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
