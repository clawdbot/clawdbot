import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import { runSecretsAudit } from "../secrets/audit.js";
import { readSecretStoreValue } from "../secrets/store/secret-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { persistProviderAuthProfileBatch } from "./provider-auth-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("provider auth protected persistence", () => {
  it("stores a provider-minted token behind a resolvable ref without an audit finding", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-store-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(rootDir, "openclaw.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir },
      async () => {
        const persisted = await persistProviderAuthProfileBatch({
          profiles: [
            {
              profileId: "github-copilot:github",
              credential: {
                type: "token",
                provider: "github-copilot",
                token: "synthetic-device-token",
              },
              secretStorage: {
                kind: "store",
                namePrefix: "GITHUB_COPILOT_TOKEN",
              },
            },
          ],
          config: {},
          env,
          stateDir,
          agentDir,
        });

        const profile = ensureAuthProfileStore(agentDir, {
          readOnly: true,
          syncExternalCli: false,
        }).profiles["github-copilot:github"];
        expect(profile).toEqual(persisted.profiles[0]?.credential);
        expect(profile).not.toHaveProperty("token");
        expect(profile).toMatchObject({
          type: "token",
          provider: "github-copilot",
          tokenRef: {
            source: "store",
            provider: "default",
            id: expect.stringMatching(/^GITHUB_COPILOT_TOKEN_[A-F0-9]{24}$/),
          },
        });
        if (!profile || profile.type !== "token" || !profile.tokenRef) {
          throw new Error("Expected persisted Copilot tokenRef");
        }
        expect(
          readSecretStoreValue({
            scope: { kind: "team" },
            name: profile.tokenRef.id,
            database: { env },
          }),
        ).toEqual({ ok: true, value: "synthetic-device-token" });

        const audit = await runSecretsAudit({ env });
        expect(
          audit.findings.some(
            (finding) =>
              finding.code === "PLAINTEXT_FOUND" &&
              finding.jsonPath === "profiles.github-copilot:github.token",
          ),
        ).toBe(false);
      },
    );
  });
});
