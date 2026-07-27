import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePersistedAuthProfileStoreRaw } from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  collectConfigAuthProfileApiKeyDriftWarnings,
  repairConfigAuthProfileApiKeyDrifts,
  scanConfigAuthProfileApiKeyDrifts,
} from "./config-auth-profile-api-key-drift.js";

function litellmStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "litellm:default": {
        type: "api_key",
        provider: "litellm",
        key,
      },
    },
  };
}

async function withStateDir(
  run: (stateDir: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-key-drift-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  try {
    await run(stateDir, env);
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("scanConfigAuthProfileApiKeyDrifts", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("detects a provider apiKey edit that never reached the stored auth profile", async () => {
    await withStateDir(async (stateDir, env) => {
      writePersistedAuthProfileStoreRaw(
        litellmStore("old-key"),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        models: { providers: { litellm: { apiKey: "new-key" } } },
      } as unknown as OpenClawConfig;

      const hits = scanConfigAuthProfileApiKeyDrifts({ cfg, env });

      expect(hits).toEqual([
        expect.objectContaining({
          provider: "litellm",
          profileId: "litellm:default",
          configApiKey: "new-key",
        }),
      ]);
      expect(
        collectConfigAuthProfileApiKeyDriftWarnings({
          hits,
          doctorFixCommand: "openclaw doctor --fix",
        }).join("\n"),
      ).toContain('Run "openclaw doctor --fix"');
    });
  });

  it("finds no drift when the config apiKey already matches the stored profile", async () => {
    await withStateDir(async (stateDir, env) => {
      writePersistedAuthProfileStoreRaw(
        litellmStore("same-key"),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        models: { providers: { litellm: { apiKey: "same-key" } } },
      } as unknown as OpenClawConfig;

      expect(scanConfigAuthProfileApiKeyDrifts({ cfg, env })).toEqual([]);
    });
  });

  it("does not flag drift when the provider entry already prefers explicit config apiKey auth", async () => {
    await withStateDir(async (stateDir, env) => {
      writePersistedAuthProfileStoreRaw(
        litellmStore("old-key"),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        models: { providers: { litellm: { apiKey: "new-key", auth: "api-key" } } },
      } as unknown as OpenClawConfig;

      expect(scanConfigAuthProfileApiKeyDrifts({ cfg, env })).toEqual([]);
    });
  });

  it("ignores a SecretRef-backed provider apiKey", async () => {
    await withStateDir(async (stateDir, env) => {
      writePersistedAuthProfileStoreRaw(
        litellmStore("old-key"),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        models: {
          providers: { litellm: { apiKey: { secretRef: "env:LITELLM_API_KEY" } } },
        },
      } as unknown as OpenClawConfig;

      expect(scanConfigAuthProfileApiKeyDrifts({ cfg, env })).toEqual([]);
    });
  });

  it("ignores providers without any stored api_key profile", async () => {
    await withStateDir(async (stateDir, env) => {
      writePersistedAuthProfileStoreRaw(
        { version: 1, profiles: {} },
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        models: { providers: { litellm: { apiKey: "new-key" } } },
      } as unknown as OpenClawConfig;

      expect(scanConfigAuthProfileApiKeyDrifts({ cfg, env })).toEqual([]);
    });
  });

  it("checks every configured agent's own auth store", async () => {
    await withStateDir(async (stateDir, env) => {
      writePersistedAuthProfileStoreRaw(
        litellmStore("primary-old-key"),
        path.join(stateDir, "agents", "primary", "agent"),
      );
      writePersistedAuthProfileStoreRaw(
        litellmStore("secondary-old-key"),
        path.join(stateDir, "agents", "secondary", "agent"),
      );
      const cfg = {
        agents: { list: [{ id: "primary", default: true }, { id: "secondary" }] },
        models: { providers: { litellm: { apiKey: "new-key" } } },
      } as unknown as OpenClawConfig;

      const hits = scanConfigAuthProfileApiKeyDrifts({ cfg, env });

      expect(hits.map((hit) => hit.profileId)).toEqual(["litellm:default", "litellm:default"]);
      expect(hits.every((hit) => hit.configApiKey === "new-key")).toBe(true);
      expect(hits).toHaveLength(2);
    });
  });
});

describe("repairConfigAuthProfileApiKeyDrifts", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("updates the stored profile so the runtime uses the newly configured apiKey", async () => {
    await withStateDir(async (stateDir, env) => {
      const agentDir = path.join(stateDir, "agents", "main", "agent");
      writePersistedAuthProfileStoreRaw(litellmStore("old-key"), agentDir);
      const cfg = {
        models: { providers: { litellm: { apiKey: "new-key" } } },
      } as unknown as OpenClawConfig;

      const result = await repairConfigAuthProfileApiKeyDrifts({ cfg, env });

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        expect.stringContaining('Updated auth profile "litellm:default"'),
      ]);
      expect(scanConfigAuthProfileApiKeyDrifts({ cfg, env })).toEqual([]);
    });
  });

  it("is a no-op when there is nothing to repair", async () => {
    await withStateDir(async (stateDir, env) => {
      writePersistedAuthProfileStoreRaw(
        litellmStore("same-key"),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        models: { providers: { litellm: { apiKey: "same-key" } } },
      } as unknown as OpenClawConfig;

      expect(await repairConfigAuthProfileApiKeyDrifts({ cfg, env })).toEqual({
        changes: [],
        warnings: [],
      });
    });
  });
});
