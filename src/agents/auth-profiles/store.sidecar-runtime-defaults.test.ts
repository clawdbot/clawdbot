import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { legacyOAuthSidecarTestUtils } from "./legacy-oauth-sidecar.js";
import { resolveAuthStorePath } from "./paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "./store.js";

const PROFILE_ID = "openai-codex:default";
const SEED = "legacy-seed";
const SIDECAR_REF = {
  source: "openclaw-credentials" as const,
  provider: "openai-codex" as const,
  id: "0123456789abcdef0123456789abcdef",
};

const envBackup: Record<string, string | undefined> = {};
const envKeys = ["OPENCLAW_STATE_DIR", "OPENCLAW_OAUTH_DIR", "OPENCLAW_AUTH_PROFILE_SECRET_KEY"];
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of envKeys) {
    envBackup[key] = process.env[key];
  }
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(() => {
  for (const key of envKeys) {
    if (envBackup[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envBackup[key];
    }
  }
  clearRuntimeAuthProfileStoreSnapshots();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setUpSidecarFixture(): { agentDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sidecar-runtime-defaults-"));
  tempDirs.push(stateDir);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.OPENCLAW_OAUTH_DIR;
  process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = SEED;

  const agentDir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    resolveAuthStorePath(agentDir),
    `${JSON.stringify(
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          [PROFILE_ID]: {
            type: "oauth",
            provider: "openai-codex",
            expires: 123456,
            accountId: "acct-legacy",
            oauthRef: SIDECAR_REF,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const sidecarPath = path.join(resolveOAuthDir(), "auth-profiles", `${SIDECAR_REF.id}.json`);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(
    sidecarPath,
    `${JSON.stringify(
      {
        version: 1,
        profileId: PROFILE_ID,
        provider: "openai-codex",
        encrypted: legacyOAuthSidecarTestUtils.encryptLegacyOAuthMaterial({
          ref: SIDECAR_REF,
          profileId: PROFILE_ID,
          provider: "openai-codex",
          seed: SEED,
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

  return { agentDir };
}

describe("secrets-runtime store loaders rehydrate legacy oauthRef sidecars by default", () => {
  it("loadAuthProfileStoreForSecretsRuntime hydrates inline tokens", () => {
    const { agentDir } = setUpSidecarFixture();
    const credential = loadAuthProfileStoreForSecretsRuntime(agentDir).profiles[PROFILE_ID];
    expect(credential).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "legacy-access-token",
      refresh: "legacy-refresh-token",
      idToken: "legacy-id-token",
    });
    expect(credential).not.toHaveProperty("oauthRef");
  });

  it("loadAuthProfileStoreWithoutExternalProfiles hydrates inline tokens", () => {
    const { agentDir } = setUpSidecarFixture();
    const credential = loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[PROFILE_ID];
    expect(credential).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "legacy-access-token",
      refresh: "legacy-refresh-token",
      idToken: "legacy-id-token",
    });
    expect(credential).not.toHaveProperty("oauthRef");
  });

  it("ensureAuthProfileStoreWithoutExternalProfiles hydrates inline tokens", () => {
    const { agentDir } = setUpSidecarFixture();
    const credential = ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[PROFILE_ID];
    expect(credential).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "legacy-access-token",
      refresh: "legacy-refresh-token",
      idToken: "legacy-id-token",
    });
    expect(credential).not.toHaveProperty("oauthRef");
  });

  it("explicit resolveLegacyOAuthSidecars: false still opts out of sidecar hydration", () => {
    const { agentDir } = setUpSidecarFixture();
    const credential = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
      resolveLegacyOAuthSidecars: false,
    }).profiles[PROFILE_ID];
    expect(credential).not.toHaveProperty("access");
    expect(credential).not.toHaveProperty("refresh");
    expect(credential).not.toHaveProperty("idToken");
  });
});
