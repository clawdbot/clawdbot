import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
} from "./auth-profiles/store.js";
import type { OAuthCredential } from "./auth-profiles/types.js";

type RuntimeOnlyOverlay = { profileId: string; credential: OAuthCredential };

const mocks = vi.hoisted(() => ({
  resolveExternalCliAuthProfiles: vi.fn<
    (store?: unknown, options?: unknown) => RuntimeOnlyOverlay[]
  >(() => []),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: mocks.resolveExternalCliAuthProfiles,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

async function withAgentDirEnv(prefix: string, run: (agentDir: string) => void | Promise<void>) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run(agentDir);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousPiAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

function writeAuthStore(agentDir: string, key: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  fs.writeFileSync(
    authPath,
    `${JSON.stringify(
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return authPath;
}

describe("auth profile store cache", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    mocks.resolveExternalCliAuthProfiles.mockReset();
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  function createRuntimeOnlyOverlay(access: string): RuntimeOnlyOverlay {
    return {
      profileId: "openai-codex:default",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + 60_000,
      },
    };
  }

  it("recomputes runtime-only external auth overlays even while the base store is cached", async () => {
    await withAgentDirEnv("openclaw-auth-store-cache-", (agentDir) => {
      writeAuthStore(agentDir, "sk-test");
      mocks.resolveExternalCliAuthProfiles
        .mockReturnValueOnce([createRuntimeOnlyOverlay("access-1")])
        .mockReturnValueOnce([createRuntimeOnlyOverlay("access-2")]);

      const first = ensureAuthProfileStore(agentDir);
      const second = ensureAuthProfileStore(agentDir);

      expect(first.profiles["openai-codex:default"]).toMatchObject({ access: "access-1" });
      expect(second.profiles["openai-codex:default"]).toMatchObject({ access: "access-2" });
      expect(mocks.resolveExternalCliAuthProfiles).toHaveBeenCalledTimes(2);
    });
  });

  it("refreshes the cached auth store after auth-profiles.json changes", async () => {
    await withAgentDirEnv("openclaw-auth-store-refresh-", async (agentDir) => {
      const authPath = writeAuthStore(agentDir, "sk-test-1");

      ensureAuthProfileStore(agentDir);

      writeAuthStore(agentDir, "sk-test-2");
      const bumpedMtime = new Date(Date.now() + 2_000);
      fs.utimesSync(authPath, bumpedMtime, bumpedMtime);

      const reloaded = ensureAuthProfileStore(agentDir);

      expect(reloaded.profiles["openai:default"]).toMatchObject({
        key: "sk-test-2",
      });
    });
  });

  it("keeps runtime-only external auth out of persisted auth-profiles.json files", async () => {
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([createRuntimeOnlyOverlay("access-1")]);

    await withAgentDirEnv("openclaw-auth-store-missing-", (agentDir) => {
      const store = ensureAuthProfileStore(agentDir);

      expect(store.profiles["openai-codex:default"]).toMatchObject({ access: "access-1" });
      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
    });
  });
});
