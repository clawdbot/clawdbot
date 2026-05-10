import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import {
  hasAvailableAuthForProvider,
  resolveApiKeyForProvider,
  resolveModelAuthMode,
} from "./model-auth.js";
import { hasAuthForModelProvider } from "./model-provider-auth.js";

async function writeWorkspaceAuthEvidencePlugin(workspaceDir: string) {
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-cloud");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.ts"), "export default {}\n", "utf8");
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "workspace-cloud",
      configSchema: { type: "object" },
      setup: {
        providers: [
          {
            id: "workspace-cloud",
            authEvidence: [
              {
                type: "local-file-with-env",
                fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
                credentialMarker: "workspace-cloud-local-credentials",
                source: "workspace cloud credentials",
              },
            ],
          },
        ],
      },
    }),
    "utf8",
  );
}

describe("workspace plugin model auth evidence", () => {
  it("uses trusted workspace plugin auth evidence across runtime and picker auth checks", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-auth-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const bundledDir = path.join(tempRoot, "bundled");
    const stateDir = path.join(tempRoot, "state");
    const credentialsPath = path.join(tempRoot, "credentials.json");
    await fs.mkdir(bundledDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(credentialsPath, "{}", "utf8");
    await writeWorkspaceAuthEvidencePlugin(workspaceDir);

    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["workspace-cloud"],
      },
    };
    const store: AuthProfileStore = { version: 1, profiles: {} };

    try {
      await withEnvAsync(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_STATE_DIR: stateDir,
          WORKSPACE_CLOUD_CREDENTIALS: credentialsPath,
        },
        async () => {
          expect(resolveEnvApiKey("workspace-cloud", process.env, { config: cfg })).toBeNull();
          expect(
            resolveEnvApiKey("workspace-cloud", process.env, {
              config: cfg,
              workspaceDir,
            }),
          ).toEqual({
            apiKey: "workspace-cloud-local-credentials",
            source: "workspace cloud credentials",
          });
          await expect(
            resolveApiKeyForProvider({
              provider: "workspace-cloud",
              cfg,
              workspaceDir,
              store,
            }),
          ).resolves.toEqual({
            apiKey: "workspace-cloud-local-credentials",
            source: "workspace cloud credentials",
            mode: "api-key",
          });
          expect(resolveModelAuthMode("workspace-cloud", cfg, store, { workspaceDir })).toBe(
            "api-key",
          );
          await expect(
            hasAvailableAuthForProvider({
              provider: "workspace-cloud",
              cfg,
              workspaceDir,
              store,
            }),
          ).resolves.toBe(true);
          expect(
            hasAuthForModelProvider({
              provider: "workspace-cloud",
              cfg,
              workspaceDir,
              store,
            }),
          ).toBe(true);
        },
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
