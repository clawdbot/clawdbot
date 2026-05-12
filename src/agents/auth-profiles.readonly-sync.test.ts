import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.fn(() => [
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
]);

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let loadAuthProfileStoreForRuntime: typeof import("./auth-profiles.js").loadAuthProfileStoreForRuntime;

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockArg(mock: MockWithCalls, label: string) {
  const call = mock.mock.calls.at(0);
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
    vi.clearAllMocks();
  });

  it("overlays runtime-only external auth without writing auth-profiles.json in read-only mode", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-readonly-sync-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
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
      fs.writeFileSync(authPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

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

      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthProfileStore;
      expect(persisted.profiles["minimax-portal:default"]).toBeUndefined();
      const persistedOpenAiProfile = persisted.profiles["openai:default"];
      expect(persistedOpenAiProfile?.type).toBe("api_key");
      if (persistedOpenAiProfile?.type !== "api_key") {
        throw new Error("expected persisted OpenAI API key profile");
      }
      expect(persistedOpenAiProfile.provider).toBe("openai");
      expect(persistedOpenAiProfile.key).toBe("sk-test");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
