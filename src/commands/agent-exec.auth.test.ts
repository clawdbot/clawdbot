import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForRuntime,
  resolveAuthProfileOrder,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { agentExecCommand } from "./agent-exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createRuntime() {
  return { runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv };
}

function successResult() {
  return {
    payloads: [{ text: "done" }],
    meta: { durationMs: 1, finalAssistantVisibleText: "done" },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("agent exec stored auth", () => {
  it("skips external Codex CLI credentials under --auth-env-only", async () => {
    const codexHome = tempDirs.make("openclaw-agent-exec-codex-home-");
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-access", refresh_token: "test-refresh" },
      }),
      "utf8",
    );
    const previousCodexHome = process.env.CODEX_HOME;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.CODEX_HOME = codexHome;
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.DATABASE_URL = "postgres://test.invalid/database";
    const { runtime } = createRuntime();
    let profileIds: string[] = [];
    let runtimeProfileIds: string[] = [];
    let hostExecApiKey: string | undefined;
    let hostExecDatabaseUrl: string | undefined;
    try {
      const { withHostExecInheritedEnvOmitted } = await import("../infra/host-env-security.js");
      await withHostExecInheritedEnvOmitted(["DATABASE_URL"], () =>
        agentExecCommand("inspect", { authEnvOnly: true }, runtime, {
          runAgent: vi.fn(async () => {
            profileIds = Object.keys(
              ensureAuthProfileStore(undefined, {
                allowKeychainPrompt: false,
                externalCliProviderIds: ["openai"],
              }).profiles,
            );
            runtimeProfileIds = Object.keys(
              loadAuthProfileStoreForRuntime(undefined, {
                allowKeychainPrompt: false,
                externalCliProviderIds: ["openai"],
              }).profiles,
            );
            const { sanitizeHostExecEnv } = await import("../infra/host-env-security.js");
            const hostExecEnv = sanitizeHostExecEnv({ baseEnv: process.env });
            hostExecApiKey = hostExecEnv.OPENAI_API_KEY;
            hostExecDatabaseUrl = hostExecEnv.DATABASE_URL;
            return successResult();
          }),
        }),
      );
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }

    expect(profileIds).toEqual([]);
    expect(runtimeProfileIds).toEqual([]);
    expect(hostExecApiKey).toBeUndefined();
    expect(hostExecDatabaseUrl).toBeUndefined();
  });

  it.each([false, true])(
    "reads portable shared credentials across temporary state (local override: %s)",
    async (localOverride) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENAI_API_KEY: undefined } },
        async (state) => {
          writeConfigMachineState("auth.sharedStore", { location: "state-db" });
          const sharedStore = {
            version: 1,
            order: { openai: ["openai:token", "openai:shared", "openai:private"] },
            usageStats: {
              "openai:token": { disabledUntil: Date.now() + 3_600_000 },
              "openai:private": { lastUsed: 123 },
            },
            profiles: {
              "openai:shared": {
                type: "api_key" as const,
                provider: "openai",
                key: "shared-test-key",
              },
              "openai:token": {
                type: "token" as const,
                provider: "openai",
                token: "shared-test-token",
              },
              "openai:private": {
                type: "api_key" as const,
                provider: "openai",
                key: "private-test-key",
                copyToAgents: false,
              },
              "openai:oauth": {
                type: "oauth" as const,
                provider: "openai",
                access: "test-access",
                refresh: "test-refresh",
                expires: Date.now() + 60_000,
                copyToAgents: true,
              },
            },
          };
          writePersistedAuthProfileStoreRaw(sharedStore);
          if (localOverride) {
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles: {
                  "openai:shared": { type: "api_key", provider: "openai", key: "local-test-key" },
                },
              },
              state.agentDir(),
            );
          }
          setRuntimeAuthProfileStoreSnapshot(sharedStore, state.agentDir());
          const { runtime } = createRuntime();
          let resolvedKey: string | undefined;
          const result = await agentExecCommand("inspect", {}, runtime, {
            runAgent: async () => {
              expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
              const store = ensureAuthProfileStore(undefined, {
                externalCli: { mode: "none" },
                syncExternalCli: false,
              });
              expect(Object.keys(store.profiles).toSorted()).toEqual([
                "openai:shared",
                "openai:token",
              ]);
              expect(
                loadAuthProfileStoreForRuntime(undefined, {
                  externalCli: { mode: "none" },
                  syncExternalCli: false,
                }).profiles,
              ).toEqual(store.profiles);
              expect(findPersistedAuthProfileCredential({ profileId: "openai:token" })).toEqual(
                sharedStore.profiles["openai:token"],
              );
              expect(store).toMatchObject({
                runtimeLocalProfileIds: localOverride ? ["openai:shared"] : [],
              });
              expect(resolveAuthProfileOrder({ store, provider: "openai", cfg: {} })).toEqual([
                "openai:shared",
                "openai:token",
              ]);
              expect(store.usageStats).toEqual({
                "openai:token": sharedStore.usageStats["openai:token"],
              });
              const { resolveApiKeyForProfile, saveAuthProfileStore } =
                await import("../agents/auth-profiles.js");
              resolvedKey = (
                await resolveApiKeyForProfile({ store, profileId: "openai:shared", cfg: {} })
              )?.apiKey;
              expect(inspectPersistedAuthProfileStoreRaw(state.agentDir()).status).toBe(
                localOverride ? "readable" : "missing",
              );
              saveAuthProfileStore(store);
              return successResult();
            },
          });
          expect(result.envelope.error).toBeUndefined();
          expect(resolvedKey).toBe(localOverride ? "local-test-key" : "shared-test-key");
          expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedStore);
          expect(readPersistedAuthProfileStoreRaw(state.agentDir())).toEqual({
            version: 1,
            profiles: localOverride
              ? {
                  "openai:shared": { type: "api_key", provider: "openai", key: "local-test-key" },
                }
              : {},
          });
        },
      );
    },
  );

  it("rejects an unreadable original shared store before entering temporary exec", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: "invalid" });
      const { runtime } = createRuntime();
      const runAgent = vi.fn(async () => successResult());
      const result = await agentExecCommand("inspect", {}, runtime, { runAgent });
      expect(result.envelope.error?.message).toContain(
        path.join(state.stateDir, "state", "openclaw.sqlite"),
      );
      expect(result.envelope.error?.message).toContain("is unreadable; run openclaw doctor --fix");
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it("reads stored credentials from the configured agent directory", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-cfg-auth-");
    const customAgentDir = path.join(stateDir, "custom-home");
    await fs.mkdir(customAgentDir, { recursive: true });
    const seedPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      seedPath,
      JSON.stringify({
        agents: { entries: { main: { agentDir: customAgentDir } } },
      }),
      "utf8",
    );
    const { saveAuthProfileStore } = await import("../agents/auth-profiles.js");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:stored": { type: "api_key", provider: "openai", key: "test-key" } },
      },
      customAgentDir,
    );
    const { runtime } = createRuntime();
    let scopedProfileIds: string[] = [];

    await agentExecCommand("inspect", { config: seedPath }, runtime, {
      runAgent: vi.fn(async () => {
        scopedProfileIds = Object.keys(loadAuthProfileStoreForRuntime()?.profiles ?? {});
        return successResult();
      }),
    });

    // The run config strips agentDir to keep run state ephemeral, but credential
    // ownership must still follow the operator's configured directory.
    expect(scopedProfileIds).toContain("openai:stored");
  });

  it("blocks direct persisted credential reads under --auth-env-only", async () => {
    const normalStateDir = tempDirs.make("openclaw-agent-exec-hidden-auth-");
    const normalAgentDir = path.join(normalStateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = normalStateDir;
    const { saveAuthProfileStore } = await import("../agents/auth-profiles.js");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:stored": { type: "api_key", provider: "openai", key: "test-key" },
        },
      },
      normalAgentDir,
    );
    const { runtime } = createRuntime();
    let persistedCredential: unknown;
    let ownerAgentDir: string | undefined;
    try {
      await agentExecCommand("inspect", { authEnvOnly: true }, runtime, {
        runAgent: vi.fn(async () => {
          persistedCredential = findPersistedAuthProfileCredential({
            agentDir: normalAgentDir,
            profileId: "openai:stored",
          });
          ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
            agentDir: normalAgentDir,
            profileId: "openai:stored",
          });
          return successResult();
        }),
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }

    expect(persistedCredential).toBeUndefined();
    expect(ownerAgentDir).toBeUndefined();
  });

  it("uses the normal stored auth profile when auth-env-only is disabled", async () => {
    const normalStateDir = tempDirs.make("openclaw-agent-exec-normal-state-");
    const normalAgentDir = path.join(normalStateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = normalStateDir;
    const { saveAuthProfileStore } = await import("../agents/auth-profiles.js");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:stored": { type: "api_key", provider: "openai", key: "test-key" },
        },
      },
      normalAgentDir,
    );
    const { runtime } = createRuntime();
    let profileIds: string[] = [];
    try {
      await agentExecCommand("inspect", { authEnvOnly: false }, runtime, {
        runAgent: vi.fn(async () => {
          expect(process.env.OPENCLAW_STATE_DIR).not.toBe(normalStateDir);
          profileIds = Object.keys(
            ensureAuthProfileStore(undefined, {
              allowKeychainPrompt: false,
              syncExternalCli: false,
            }).profiles,
          );
          return successResult();
        }),
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }

    expect(profileIds).toContain("openai:stored");
  });
});
