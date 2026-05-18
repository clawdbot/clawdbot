import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthStatePath, resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { writeCachedAuthProfileStore } from "../agents/auth-profiles/store-cache.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearSecretsRuntimeSnapshot } from "./runtime-state.js";

function authStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key,
      },
    },
  };
}

describe("secrets runtime state", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("clears loaded auth-profile cache without importing the full secrets runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-state-cache-"));
    process.env.OPENCLAW_STATE_DIR = root;
    const agentDir = path.join(root, "agents", "default", "agent");

    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const authPath = resolveAuthStorePath(agentDir);
      const statePath = resolveAuthStatePath(agentDir);
      fs.writeFileSync(authPath, `${JSON.stringify(authStore("sk-new"))}\n`);
      const stat = fs.statSync(authPath);
      writeCachedAuthProfileStore({
        authPath,
        authMtimeMs: stat.mtimeMs,
        stateMtimeMs: fs.existsSync(statePath) ? fs.statSync(statePath).mtimeMs : null,
        store: authStore("sk-old"),
      });

      expect(
        loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false }).profiles[
          "openai:default"
        ],
      ).toMatchObject({ key: "sk-old" });

      clearSecretsRuntimeSnapshot();

      expect(
        loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false }).profiles[
          "openai:default"
        ],
      ).toMatchObject({ key: "sk-new" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
