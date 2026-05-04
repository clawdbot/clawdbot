import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { promoteAuthProfileInOrder } from "./profiles.js";
import { loadAuthProfileStoreForRuntime, saveAuthProfileStore } from "./store.js";

describe("promoteAuthProfileInOrder", () => {
  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-order-promote-"));
    try {
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
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
