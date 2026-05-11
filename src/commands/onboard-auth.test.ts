import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAuthProfileConfig,
  upsertApiKeyProfile,
  writeOAuthCredentials,
} from "../plugins/provider-auth-helpers.js";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

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

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => process.env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

vi.mock("../agents/auth-profiles/profiles.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    upsertAuthProfile: (params: { profileId: string; credential: unknown; agentDir?: string }) => {
      const stateDir = process.env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state";
      const agentDir = params.agentDir ?? path.join(stateDir, "agents", "main", "agent");
      const file = path.join(agentDir, "auth-profiles.json");
      fs.mkdirSync(agentDir, { recursive: true });
      const existing = (() => {
        try {
          return JSON.parse(fs.readFileSync(file, "utf8")) as {
            version?: number;
            profiles?: Record<string, unknown>;
          };
        } catch {
          return { version: 1, profiles: {} };
        }
      })();
      fs.writeFileSync(
        file,
        `${JSON.stringify(
          {
            version: existing.version ?? 1,
            profiles: {
              ...existing.profiles,
              [params.profileId]: params.credential,
            },
          },
          null,
          2,
        )}\n`,
      );
    },
  };
});

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
}));

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(typeof value, label).toBe("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function expectFields(value: unknown, expected: Record<string, unknown>, label = "record") {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
  return record;
}

async function expectMissingFile(readPromise: Promise<unknown>) {
  try {
    await readPromise;
  } catch (error) {
    expectFields(error, { code: "ENOENT" }, "read error");
    return;
  }
  throw new Error("Expected file read to fail with ENOENT");
}

describe("writeOAuthCredentials", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OPENCLAW_OAUTH_DIR",
  ]);

  let tempStateDir: string;
  const authProfilePathFor = (dir: string) => path.join(dir, "auth-profiles.json");

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("writes auth-profiles.json under the default agent dir", async () => {
    const env = await setupAuthTestEnv("openclaw-oauth-");
    lifecycle.setStateDir(env.stateDir);
    const defaultAgentDir = path.join(env.stateDir, "agents", "main", "agent");

    const creds = {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds);

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    }>(defaultAgentDir);
    expectFields(parsed.profiles?.["openai-codex:default"], {
      refresh: "refresh-token",
      access: "access-token",
      type: "oauth",
    });

    await expectMissingFile(fs.readFile(path.join(env.agentDir, "auth-profiles.json"), "utf8"));
  });

  it("writes OAuth credentials to all sibling agent dirs when syncSiblingAgents=true", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-sync-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const mainAgentDir = path.join(tempStateDir, "agents", "main", "agent");
    const kidAgentDir = path.join(tempStateDir, "agents", "kid", "agent");
    const workerAgentDir = path.join(tempStateDir, "agents", "worker", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(kidAgentDir, { recursive: true });
    await fs.mkdir(workerAgentDir, { recursive: true });

    process.env.OPENCLAW_AGENT_DIR = kidAgentDir;
    process.env.PI_CODING_AGENT_DIR = kidAgentDir;

    const creds = {
      refresh: "refresh-sync",
      access: "access-sync",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds, undefined, {
      syncSiblingAgents: true,
    });

    for (const dir of [mainAgentDir, kidAgentDir, workerAgentDir]) {
      const raw = await fs.readFile(authProfilePathFor(dir), "utf8");
      const parsed = JSON.parse(raw) as {
        profiles?: Record<string, OAuthCredentials & { type?: string }>;
      };
      expectFields(parsed.profiles?.["openai-codex:default"], {
        refresh: "refresh-sync",
        access: "access-sync",
        type: "oauth",
      });
    }
  });

  it("writes OAuth credentials only to target dir by default", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-nosync-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const mainAgentDir = path.join(tempStateDir, "agents", "main", "agent");
    const kidAgentDir = path.join(tempStateDir, "agents", "kid", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(kidAgentDir, { recursive: true });

    process.env.OPENCLAW_AGENT_DIR = kidAgentDir;
    process.env.PI_CODING_AGENT_DIR = kidAgentDir;

    const creds = {
      refresh: "refresh-kid",
      access: "access-kid",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds, kidAgentDir);

    const kidRaw = await fs.readFile(authProfilePathFor(kidAgentDir), "utf8");
    const kidParsed = JSON.parse(kidRaw) as {
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    };
    expectFields(kidParsed.profiles?.["openai-codex:default"], {
      access: "access-kid",
      type: "oauth",
    });

    await expectMissingFile(fs.readFile(authProfilePathFor(mainAgentDir), "utf8"));
  });

  it("syncs siblings from explicit agentDir outside OPENCLAW_STATE_DIR", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-external-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

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

    await writeOAuthCredentials("openai-codex", creds, extKid, {
      syncSiblingAgents: true,
    });

    // All siblings under the external root should have credentials
    for (const dir of [extMain, extKid, extWorker]) {
      const raw = await fs.readFile(authProfilePathFor(dir), "utf8");
      const parsed = JSON.parse(raw) as {
        profiles?: Record<string, OAuthCredentials & { type?: string }>;
      };
      expectFields(parsed.profiles?.["openai-codex:default"], {
        refresh: "refresh-ext",
        access: "access-ext",
        type: "oauth",
      });
    }

    // Global state dir should NOT have credentials written
    const globalMain = path.join(tempStateDir, "agents", "main", "agent");
    await expectMissingFile(fs.readFile(authProfilePathFor(globalMain), "utf8"));
  });
});

describe("upsertApiKeyProfile secret refs", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
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

  it("handles plaintext, ref mode, and inline env-ref provider keys", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-");
    lifecycle.setStateDir(env.stateDir);
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
    lifecycle.setStateDir(env.stateDir);
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
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("writes to the default agent dir", async () => {
    const env = await setupAuthTestEnv("openclaw-minimax-", { agentSubdir: "custom-agent" });
    lifecycle.setStateDir(env.stateDir);
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

    await expectMissingFile(fs.readFile(path.join(env.agentDir, "auth-profiles.json"), "utf8"));
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
        profileId: "openai-codex:id-abc",
        provider: "openai-codex",
        mode: "oauth",
        displayName: "Work account",
      },
    );

    expect(next.auth?.profiles?.["openai-codex:id-abc"]).toEqual({
      provider: "openai-codex",
      mode: "oauth",
      displayName: "Work account",
    });
  });
});
