import fs from "node:fs/promises";
import path from "node:path";
// Onboard auth tests cover provider auth setup, credential persistence, and auth-profile state.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "../../test/helpers/auth-wizard.js";
import type { OAuthCredentials } from "../llm/utils/oauth/types.js";
import {
  applyAuthProfileConfig,
  upsertApiKeyProfile,
  writeOAuthCredentials,
} from "../plugins/provider-auth-helpers.js";
import { setTestEnvValue } from "../test-utils/env.js";

const providerEnvVarsById = vi.hoisted(
  (): Record<string, readonly string[]> => ({
    "cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
    byteplus: ["BYTEPLUS_API_KEY"],
    moonshot: ["MOONSHOT_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    opencode: ["OPENCODE_API_KEY"],
    "opencode-go": ["OPENCODE_API_KEY"],
    volcengine: ["VOLCANO_ENGINE_API_KEY"],
  }),
);

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  resolveStateDir: () => process.env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

vi.mock("../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    if (normalized === "z.ai" || normalized === "z-ai") {
      return "zai";
    }
    return normalized;
  },
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVars: vi.fn((provider: string) => providerEnvVarsById[provider] ?? []),
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

const requireRecord = createRequireRecord("object", "expected-label");

function expectFields(value: unknown, expected: Record<string, unknown>, label = "record") {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
  return record;
}

describe("writeOAuthCredentials", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_OAUTH_DIR",
  ]);

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("persists OAuth credentials under the default agent SQLite store", async () => {
    const env = await setupAuthTestEnv("openclaw-oauth-");
    lifecycle.track(env);
    const defaultAgentDir = path.join(env.stateDir, "agents", "main", "agent");

    const creds = {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai", creds);

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    }>(defaultAgentDir);
    expectFields(parsed.profiles?.["openai:default"], {
      refresh: "refresh-token",
      access: "access-token",
      type: "oauth",
    });

    await expect(readAuthProfilesForAgent(env.agentDir)).rejects.toThrow(
      "Expected SQLite auth profile store",
    );
  });

  it("persists primary and main OAuth rows while later siblings inherit", async () => {
    const env = await setupAuthTestEnv("openclaw-oauth-sync-");
    lifecycle.track(env);
    const tempStateDir = env.stateDir;

    const mainAgentDir = path.join(tempStateDir, "agents", "main", "agent");
    const kidAgentDir = path.join(tempStateDir, "agents", "kid", "agent");
    const workerAgentDir = path.join(tempStateDir, "agents", "worker", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(kidAgentDir, { recursive: true });
    await fs.mkdir(workerAgentDir, { recursive: true });

    setTestEnvValue("OPENCLAW_AGENT_DIR", kidAgentDir);

    const creds = {
      refresh: "refresh-sync",
      access: "access-sync",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai", creds, undefined, {
      syncSiblingAgents: true,
    });

    for (const dir of [mainAgentDir, kidAgentDir]) {
      const persistedStore = await readAuthProfilesForAgent<{
        profiles?: Record<string, OAuthCredentials & { type?: string }>;
      }>(dir);
      expectFields(persistedStore.profiles?.["openai:default"], {
        refresh: "refresh-sync",
        access: "access-sync",
        type: "oauth",
      });
    }
    const inheritedSiblingStore = await readAuthProfilesForAgent<{
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    }>(workerAgentDir);
    expect(inheritedSiblingStore.profiles).toEqual({});
  });

  it("writes OAuth credentials only to target dir by default", async () => {
    const env = await setupAuthTestEnv("openclaw-oauth-nosync-");
    lifecycle.track(env);
    const tempStateDir = env.stateDir;

    const mainAgentDir = path.join(tempStateDir, "agents", "main", "agent");
    const kidAgentDir = path.join(tempStateDir, "agents", "kid", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(kidAgentDir, { recursive: true });

    setTestEnvValue("OPENCLAW_AGENT_DIR", kidAgentDir);

    const creds = {
      refresh: "refresh-kid",
      access: "access-kid",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai", creds, kidAgentDir);

    const kidParsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    }>(kidAgentDir);
    expectFields(kidParsed.profiles?.["openai:default"], {
      access: "access-kid",
      type: "oauth",
    });

    await expect(readAuthProfilesForAgent(mainAgentDir)).rejects.toThrow(
      "Expected SQLite auth profile store",
    );
  });

  it("syncs siblings from explicit agentDir outside OPENCLAW_STATE_DIR", async () => {
    const env = await setupAuthTestEnv("openclaw-oauth-external-");
    lifecycle.track(env);
    const tempStateDir = env.stateDir;

    // Create standard-layout agents tree *outside* OPENCLAW_STATE_DIR
    const externalRoot = path.join(tempStateDir, "external", "agents");
    const extMain = path.join(externalRoot, "main", "agent");
    const extKid = path.join(externalRoot, "kid", "agent");
    const extWorker = path.join(externalRoot, "worker", "agent");
    await fs.mkdir(extMain, { recursive: true });
    await fs.mkdir(extKid, { recursive: true });
    await fs.mkdir(extWorker, { recursive: true });

    const creds = {
      refresh: "refresh-ext",
      access: "access-ext",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai", creds, extKid, {
      syncSiblingAgents: true,
    });

    // All siblings under the external root should have credentials
    for (const dir of [extMain, extKid, extWorker]) {
      const parsed = await readAuthProfilesForAgent<{
        profiles?: Record<string, OAuthCredentials & { type?: string }>;
      }>(dir);
      expectFields(parsed.profiles?.["openai:default"], {
        refresh: "refresh-ext",
        access: "access-ext",
        type: "oauth",
      });
    }

    // Global state dir should NOT have credentials written
    const globalMain = path.join(tempStateDir, "agents", "main", "agent");
    await expect(readAuthProfilesForAgent(globalMain)).rejects.toThrow(
      "Expected SQLite auth profile store",
    );
  });
});

describe("upsertApiKeyProfile secret refs", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "MOONSHOT_API_KEY",
    "OPENAI_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "VOLCANO_ENGINE_API_KEY",
    "BYTEPLUS_API_KEY",
    "OPENCODE_API_KEY",
  ]);

  type AuthProfileEntry = { key?: string; keyRef?: unknown; metadata?: unknown };

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  async function readProfile(
    agentDir: string,
    profileId: string,
  ): Promise<AuthProfileEntry | undefined> {
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, AuthProfileEntry>;
    }>(agentDir);
    return parsed.profiles?.[profileId];
  }

  async function readProfileIds(agentDir: string): Promise<string[]> {
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, AuthProfileEntry>;
    }>(agentDir);
    return Object.keys(parsed.profiles ?? {}).toSorted();
  }

  it("handles plaintext, ref mode, and inline env-ref provider keys", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-");
    lifecycle.track(env);
    process.env.MOONSHOT_API_KEY = "sk-moonshot-env"; // pragma: allowlist secret
    process.env.OPENAI_API_KEY = "sk-openai-env"; // pragma: allowlist secret

    upsertApiKeyProfile({
      provider: "moonshot",
      input: "sk-moonshot-env",
      agentDir: env.agentDir,
    });
    upsertApiKeyProfile({ provider: "openai", input: "sk-openai-env", agentDir: env.agentDir });

    expectFields(await readProfile(env.agentDir, "moonshot:default"), {
      key: "sk-moonshot-env",
    });
    expect((await readProfile(env.agentDir, "moonshot:default"))?.keyRef).toBeUndefined();
    expectFields(await readProfile(env.agentDir, "openai:default"), {
      key: "sk-openai-env",
    });
    expect((await readProfile(env.agentDir, "openai:default"))?.keyRef).toBeUndefined();

    upsertApiKeyProfile({
      provider: "moonshot",
      input: "sk-moonshot-env",
      agentDir: env.agentDir,
      options: { secretInputMode: "ref" }, // pragma: allowlist secret
    });
    upsertApiKeyProfile({
      provider: "openai",
      input: "sk-openai-env",
      agentDir: env.agentDir,
      options: { secretInputMode: "ref" }, // pragma: allowlist secret
    });
    upsertApiKeyProfile({
      provider: "moonshot",
      input: "${MOONSHOT_API_KEY}",
      agentDir: env.agentDir,
      profileId: "moonshot:inline",
    });
    process.env.MOONSHOT_API_KEY = "sk-moonshot-other"; // pragma: allowlist secret
    upsertApiKeyProfile({
      provider: "moonshot",
      input: "sk-moonshot-plaintext",
      agentDir: env.agentDir,
      profileId: "moonshot:plain",
    });

    expectFields(await readProfile(env.agentDir, "moonshot:default"), {
      keyRef: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
    });
    expect((await readProfile(env.agentDir, "moonshot:default"))?.key).toBeUndefined();
    expectFields(await readProfile(env.agentDir, "openai:default"), {
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect((await readProfile(env.agentDir, "openai:default"))?.key).toBeUndefined();
    expectFields(await readProfile(env.agentDir, "moonshot:inline"), {
      keyRef: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
    });
    expectFields(await readProfile(env.agentDir, "moonshot:plain"), {
      key: "sk-moonshot-plaintext",
    });
    expect((await readProfile(env.agentDir, "moonshot:plain"))?.keyRef).toBeUndefined();
  });

  it("stores provider-specific env refs and metadata in ref mode", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-provider-ref-");
    lifecycle.track(env);
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "cf-secret"; // pragma: allowlist secret
    process.env.VOLCANO_ENGINE_API_KEY = "volcengine-secret"; // pragma: allowlist secret
    process.env.BYTEPLUS_API_KEY = "byteplus-secret"; // pragma: allowlist secret
    process.env.OPENCODE_API_KEY = "sk-opencode-env"; // pragma: allowlist secret

    upsertApiKeyProfile({
      provider: "cloudflare-ai-gateway",
      input: "cf-secret",
      agentDir: env.agentDir,
      options: { secretInputMode: "ref" }, // pragma: allowlist secret
      metadata: {
        accountId: "account-1",
        gatewayId: "gateway-1",
      },
    });
    for (const [provider, input] of [
      ["volcengine", "volcengine-secret"],
      ["byteplus", "byteplus-secret"],
      ["opencode", "sk-opencode-env"],
      ["opencode-go", "sk-opencode-env"],
    ] as const) {
      upsertApiKeyProfile({
        provider,
        input,
        agentDir: env.agentDir,
        options: { secretInputMode: "ref" }, // pragma: allowlist secret
      });
    }

    expect(await readProfileIds(env.agentDir)).toEqual([
      "byteplus:default",
      "cloudflare-ai-gateway:default",
      "opencode-go:default",
      "opencode:default",
      "volcengine:default",
    ]);
    expectFields(await readProfile(env.agentDir, "cloudflare-ai-gateway:default"), {
      keyRef: { source: "env", provider: "default", id: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
      metadata: { accountId: "account-1", gatewayId: "gateway-1" },
    });
    expect((await readProfile(env.agentDir, "cloudflare-ai-gateway:default"))?.key).toBeUndefined();
    expectFields(await readProfile(env.agentDir, "volcengine:default"), {
      keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
    });
    expectFields(await readProfile(env.agentDir, "byteplus:default"), {
      keyRef: { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
    });
    expectFields(await readProfile(env.agentDir, "opencode:default"), {
      keyRef: { source: "env", provider: "default", id: "OPENCODE_API_KEY" },
    });
    expectFields(await readProfile(env.agentDir, "opencode-go:default"), {
      keyRef: { source: "env", provider: "default", id: "OPENCODE_API_KEY" },
    });
  });
});

describe("upsertApiKeyProfile", () => {
  const lifecycle = createAuthTestLifecycle(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR"]);

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("writes to the default agent dir", async () => {
    const env = await setupAuthTestEnv("openclaw-minimax-", { agentSubdir: "custom-agent" });
    lifecycle.track(env);
    const defaultAgentDir = path.join(env.stateDir, "agents", "main", "agent");

    upsertApiKeyProfile({ provider: "minimax", input: "sk-minimax-test" });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { type?: string; provider?: string; key?: string }>;
    }>(defaultAgentDir);
    expectFields(parsed.profiles?.["minimax:default"], {
      type: "api_key",
      provider: "minimax",
      key: "sk-minimax-test",
    });

    await expect(readAuthProfilesForAgent(env.agentDir)).rejects.toThrow(
      "Expected SQLite auth profile store",
    );
  });
});

describe("applyAuthProfileConfig", () => {
  it("promotes the newly selected profile to the front of auth.order", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "api_key" },
          },
          order: { anthropic: ["anthropic:default"] },
        },
      },
      {
        profileId: "anthropic:work",
        provider: "anthropic",
        mode: "oauth",
      },
    );

    expect(next.auth?.order?.anthropic).toEqual(["anthropic:work", "anthropic:default"]);
  });

  it("creates provider order when switching from legacy oauth to api_key without explicit order", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "kilocode:legacy": { provider: "kilocode", mode: "oauth" },
          },
        },
      },
      {
        profileId: "kilocode:default",
        provider: "kilocode",
        mode: "api_key",
      },
    );

    expect(next.auth?.order?.kilocode).toEqual(["kilocode:default", "kilocode:legacy"]);
  });

  it("repairs aliased auth.order keys instead of duplicating them", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "zai:default": { provider: "z.ai", mode: "api_key" },
          },
          order: { "z.ai": ["zai:default"] },
        },
      },
      {
        profileId: "zai:work",
        provider: "z-ai",
        mode: "oauth",
      },
    );

    expect(next.auth?.order).toEqual({
      zai: ["zai:work", "zai:default"],
    });
  });

  it("merges split canonical and aliased auth.order entries for the same provider", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "zai:default": { provider: "z.ai", mode: "api_key" },
            "zai:backup": { provider: "z-ai", mode: "token" },
          },
          order: {
            zai: ["zai:default"],
            "z.ai": ["zai:backup"],
          },
        },
      },
      {
        profileId: "zai:work",
        provider: "z-ai",
        mode: "oauth",
      },
    );

    expect(next.auth?.order).toEqual({
      zai: ["zai:work", "zai:default", "zai:backup"],
    });
  });

  it("keeps implicit round-robin when no mixed provider modes are present", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "kilocode:legacy": { provider: "kilocode", mode: "api_key" },
          },
        },
      },
      {
        profileId: "kilocode:default",
        provider: "kilocode",
        mode: "api_key",
      },
    );

    expect(next.auth?.order).toBeUndefined();
  });

  it("stores display metadata without overloading email", () => {
    const next = applyAuthProfileConfig(
      {},
      {
        profileId: "openai:id-abc",
        provider: "openai",
        mode: "oauth",
        displayName: "Work account",
      },
    );

    expect(next.auth?.profiles?.["openai:id-abc"]).toEqual({
      provider: "openai",
      mode: "oauth",
      displayName: "Work account",
    });
  });
});
