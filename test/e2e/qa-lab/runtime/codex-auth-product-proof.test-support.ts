import fs from "node:fs/promises";
import { expect } from "vitest";
import { loadPersistedAuthProfileStore } from "../../../../src/agents/auth-profiles/persisted.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";

const OAUTH_PROFILE_ID = "openai:qa-oauth";
const LEGACY_OAUTH_PROFILE_ID = "openai-codex:qa-oauth";
const API_KEY_PROFILE_ID = "openai:media-api";

export type CodexAuthMigrationShape = "mixed" | "oauth-only";

export async function runCodexAuthDoctorMigrationProof(
  instance: OpenClawTestInstance,
  params: {
    accountId: string;
    oauthAccess: string;
    shape: CodexAuthMigrationShape;
  },
) {
  const includeApiKey = params.shape === "mixed";
  const expectedOrder = includeApiKey ? [OAUTH_PROFILE_ID, API_KEY_PROFILE_ID] : [OAUTH_PROFILE_ID];
  const profiles: Record<string, Record<string, unknown>> = {
    [LEGACY_OAUTH_PROFILE_ID]: {
      type: "oauth",
      provider: "openai-codex",
      access: params.oauthAccess,
      refresh: "test-refresh",
      expires: Date.UTC(2036, 0, 1),
      accountId: params.accountId,
    },
  };
  const order: Record<string, string[]> = {
    "openai-codex": [LEGACY_OAUTH_PROFILE_ID],
  };
  if (includeApiKey) {
    profiles[API_KEY_PROFILE_ID] = {
      type: "api_key",
      provider: "openai",
      key: "test-api-key",
    };
    order.openai = [API_KEY_PROFILE_ID];
  }

  const legacyAuthPath = await instance.state.writeText(
    "agents/main/agent/auth-profiles.json",
    `${JSON.stringify({ version: 1, profiles, order }, null, 2)}\n`,
  );
  const doctor = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
    timeoutMs: 120_000,
  });
  expect(doctor.code, doctor.stderr).toBe(0);

  const canonicalStore = loadPersistedAuthProfileStore(instance.state.agentDir());
  const expectedProfiles: Record<string, Record<string, unknown>> = {
    [OAUTH_PROFILE_ID]: {
      type: "oauth",
      provider: "openai",
      access: params.oauthAccess,
      refresh: "test-refresh",
      expires: Date.UTC(2036, 0, 1),
      accountId: params.accountId,
    },
  };
  if (includeApiKey) {
    expectedProfiles[API_KEY_PROFILE_ID] = { type: "api_key", provider: "openai" };
  }
  expect(canonicalStore).toMatchObject({
    profiles: expectedProfiles,
    order: { openai: expectedOrder },
  });
  expect(canonicalStore?.profiles[LEGACY_OAUTH_PROFILE_ID]).toBeUndefined();
  await expect(fs.access(legacyAuthPath)).rejects.toMatchObject({ code: "ENOENT" });
  return canonicalStore;
}
