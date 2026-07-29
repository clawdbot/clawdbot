/**
 * Read-only external auth overlay tests.
 * Ensures runtime profile overlays do not persist or sync when callers request
 * read-only auth-profile resolution.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { externalCliDiscoveryScoped } from "./auth-profiles/external-cli-discovery.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const { resolveExternalAuthProfilesWithPluginsMock } = vi.hoisted(() => ({
  resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => [
    {
      profileId: "minimax-portal:default",
      credential: {
        type: "oauth" as const,
        provider: "minimax-portal",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      persistence: "runtime-only" as const,
    },
  ]),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let loadAuthProfileStoreForRuntime: typeof import("./auth-profiles.js").loadAuthProfileStoreForRuntime;

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockArg(mock: MockWithCalls, label: string) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

describe("auth profiles read-only external auth overlay", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ clearRuntimeAuthProfileStoreSnapshots, loadAuthProfileStoreForRuntime } =
      await import("./auth-profiles.js"));
    clearRuntimeAuthProfileStoreSnapshots();
    resolveExternalAuthProfilesWithPluginsMock.mockClear();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    vi.clearAllMocks();
  });

  it("overlays runtime-only external auth without writing auth-profiles.json in read-only mode", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-readonly-sync-"));
    try {
      const baseline: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      };
      saveAuthProfileStore(baseline, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });

      const loaded = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(resolveExternalAuthProfilesWithPluginsMock).toHaveBeenCalledTimes(1);
      const externalAuthCall = firstMockArg(
        resolveExternalAuthProfilesWithPluginsMock,
        "resolveExternalAuthProfilesWithPlugins",
      ) as
        | {
            config?: unknown;
            context?: {
              agentDir?: string;
              store?: AuthProfileStore;
              workspaceDir?: string;
            };
          }
        | undefined;
      expect(externalAuthCall?.config).toBeUndefined();
      expect(externalAuthCall?.context?.agentDir).toBe(agentDir);
      expect(externalAuthCall?.context?.workspaceDir).toBeUndefined();
      expect(externalAuthCall?.context?.store?.version).toBe(AUTH_STORE_VERSION);
      expect(externalAuthCall?.context?.store?.profiles).toStrictEqual(baseline.profiles);
      expect(loaded.profiles["minimax-portal:default"]?.type).toBe("oauth");
      expect(loaded.profiles["minimax-portal:default"]?.provider).toBe("minimax-portal");

      const persisted = loadPersistedAuthProfileStore(agentDir) ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      expect(persisted.profiles["minimax-portal:default"]).toBeUndefined();
      const persistedOpenAiProfile = persisted.profiles["openai:default"];
      expect(persistedOpenAiProfile?.type).toBe("api_key");
      if (persistedOpenAiProfile?.type !== "api_key") {
        throw new Error("expected persisted OpenAI API key profile");
      }
      expect(persistedOpenAiProfile.provider).toBe("openai");
      expect(persistedOpenAiProfile.key).toBe("sk-test");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("passes scoped external auth config to provider hooks", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-scoped-config-"));
    const profileId = "google-gemini-cli:user@example.test";
    const cfg = {
      auth: {
        profiles: {
          [profileId]: {
            provider: "google-gemini-cli",
            mode: "oauth" as const,
            email: "user@example.test",
          },
        },
      },
    };
    try {
      loadAuthProfileStoreForRuntime(agentDir, {
        readOnly: true,
        externalCli: externalCliDiscoveryScoped({
          config: cfg,
          providerIds: ["google-gemini-cli"],
          profileIds: [profileId],
        }),
      });

      expect(resolveExternalAuthProfilesWithPluginsMock).toHaveBeenCalledTimes(1);
      const externalAuthCall = firstMockArg(
        resolveExternalAuthProfilesWithPluginsMock,
        "resolveExternalAuthProfilesWithPlugins",
      ) as
        | {
            config?: unknown;
            context?: {
              config?: unknown;
            };
          }
        | undefined;
      expect(externalAuthCall?.config).toBe(cfg);
      expect(externalAuthCall?.context?.config).toBe(cfg);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
