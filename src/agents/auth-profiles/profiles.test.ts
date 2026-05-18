import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthStorePath } from "./paths.js";
import { promoteAuthProfileInOrder, upsertAuthProfileWithLock } from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

type ExpectedOAuthCredentialFields = {
  provider: string;
  access?: string;
  refresh?: string;
  idToken?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};

function expectOAuthCredentialFields(
  value: unknown,
  expected: ExpectedOAuthCredentialFields,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected OAuth credential object");
  }
  const credential = value as Record<string, unknown>;
  expect(credential.type).toBe("oauth");
  expect(credential.provider).toBe(expected.provider);
  for (const field of [
    "access",
    "refresh",
    "idToken",
    "expires",
    "email",
    "accountId",
    "chatgptPlanType",
  ] as const) {
    if (field in expected) {
      expect(credential[field]).toBe(expected[field]);
    }
  }
  return credential;
}

describe("promoteAuthProfileInOrder", () => {
  it("normalizes copied secrets when using the locked upsert path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-upsert-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousOAuthDir = process.env.OPENCLAW_OAUTH_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_OAUTH_DIR;
    try {
      fs.mkdirSync(agentDir, { recursive: true });

      await upsertAuthProfileWithLock({
        profileId: "openai:manual",
        credential: {
          type: "token",
          provider: "openai",
          token: "  bearer\r\n-token\u2502  ",
        },
        agentDir,
      });
      await upsertAuthProfileWithLock({
        profileId: "anthropic:key",
        credential: {
          type: "api_key",
          provider: "anthropic",
          key: "  sk-\r\nant\u2502  ",
        },
        agentDir,
      });

      const profiles = loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles;
      expect(profiles["openai:manual"]).toMatchObject({
        type: "token",
        provider: "openai",
        token: "bearer-token",
      });
      expect(profiles["anthropic:key"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant",
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousOAuthDir === undefined) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = previousOAuthDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("persists openai-codex oauth credentials inline", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-metadata-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "local-access-token",
              refresh: "local-refresh-token",
              idToken: "local-id-token",
              expires,
              email: "dev@example.test",
              accountId: "acct-local",
              chatgptPlanType: "plus",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = persisted.profiles[profileId];

      expectOAuthCredentialFields(credential, {
        provider: "openai-codex",
        access: "local-access-token",
        refresh: "local-refresh-token",
        idToken: "local-id-token",
        expires,
        email: "dev@example.test",
        accountId: "acct-local",
        chatgptPlanType: "plus",
      });
      expect(credential).not.toHaveProperty("oauthRef");
      expect(fs.existsSync(path.join(resolveOAuthDir(), "auth-profiles"))).toBe(false);

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "local-access-token",
          refresh: "local-refresh-token",
          idToken: "local-id-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves access-only openai-codex oauth credentials inline", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-access-only-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "access-only-token",
              expires,
            } as AuthProfileStore["profiles"][string],
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = persisted.profiles[profileId];
      expectOAuthCredentialFields(credential, {
        provider: "openai-codex",
        access: "access-only-token",
        expires,
      });
      expect(credential).not.toHaveProperty("oauthRef");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "access-only-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps copied openai-codex oauth profiles inline", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-copy-ref-"));
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const copiedAgentDir = path.join(stateDir, "agents", "copied", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(copiedAgentDir, { recursive: true });
      const originalProfileId = "openai-codex:default";
      const copiedProfileId = "openai-codex:copied";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [originalProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "copy-access-token",
              refresh: "copy-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
              copyToAgents: true,
            },
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const originalCredential =
        loadAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[originalProfileId];
      expect(originalCredential?.type).toBe("oauth");
      if (!originalCredential || originalCredential.type !== "oauth") {
        throw new Error("expected original oauth credential");
      }
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [copiedProfileId]: originalCredential,
          },
        },
        copiedAgentDir,
        { filterExternalAuthProfiles: false },
      );

      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {},
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(copiedAgentDir).profiles[copiedProfileId],
        {
          provider: "openai-codex",
          access: "copy-access-token",
          refresh: "copy-refresh-token",
        },
      );
      const copiedRaw = fs.readFileSync(resolveAuthStorePath(copiedAgentDir), "utf8");
      expect(copiedRaw).toContain("copy-access-token");
      expect(copiedRaw).toContain("copy-refresh-token");
      expect(copiedRaw).not.toContain("oauthRef");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-order-promote-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai-codex:bunsthedev@gmail.com";
      const staleProfileId = "openai-codex:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai-codex",
        profileId: newProfileId,
      });

      expect(updated?.order?.["openai-codex"]).toEqual([newProfileId, staleProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai-codex"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
