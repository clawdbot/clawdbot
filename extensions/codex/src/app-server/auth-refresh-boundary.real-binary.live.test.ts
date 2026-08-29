import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexModelListResponse, CodexTurnCompletedNotification } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_AUTH === "1";
const describeLive = LIVE ? describe : describe.skip;

type CodexAuthFile = {
  tokens?: { access_token?: string; account_id?: string };
};

function corruptJwtSignature(token: string): string {
  const segments = token.split(".");
  const signature = segments[2];
  if (segments.length !== 3 || !signature) {
    throw new Error("The current Codex access credential is not a signed JWT.");
  }
  const replacement = signature[0] === "A" ? "B" : "A";
  const corruptedSignature = `${replacement}${signature.slice(1)}`;
  if (Buffer.from(corruptedSignature, "base64url").equals(Buffer.from(signature, "base64url"))) {
    throw new Error("JWT signature corruption did not change the decoded signature.");
  }
  return `${segments[0]}.${segments[1]}.${corruptedSignature}`;
}

describeLive("Codex app-server real auth refresh boundary", () => {
  it("recovers a real provider turn through OpenClaw's refresh handler", async () => {
    const auth = JSON.parse(
      await fs.readFile(path.join(os.homedir(), ".codex", "auth.json"), "utf8"),
    ) as CodexAuthFile;
    const accessToken = auth.tokens?.access_token?.trim();
    const accountId = auth.tokens?.account_id?.trim();
    if (!accessToken || !accountId) {
      throw new Error("A current Codex ChatGPT login is required for this live proof.");
    }
    const invalidAccessToken = corruptJwtSignature(accessToken);
    expect(invalidAccessToken === accessToken).toBe(false);

    await withTempDir("openclaw-codex-auth-refresh-live-", async (root) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
        const profileId = "openai:boundary-proof";
        const placeholderRefresh = "ephemeral-live-boundary-placeholder";
        const agentDir = path.join(root, "agent");
        await fs.mkdir(agentDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai",
                access: invalidAccessToken,
                refresh: placeholderRefresh,
                expires: Date.now() + 60 * 60_000,
                accountId,
              },
            },
          },
          agentDir,
        );
        const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
        expect(store.runtimePersistedProfileIds?.includes(profileId)).toBe(true);
        let providerRefreshes = 0;
        const registry = createEmptyPluginRegistry();
        registry.providers.push({
          pluginId: "openai-live-boundary",
          source: "live-test",
          provider: {
            id: "openai",
            label: "OpenAI live auth boundary",
            auth: [],
            refreshOAuth: async (credential) => {
              // Keep the operator's rotating grant out of this proof. This
              // in-process hook injects only the current access credential.
              providerRefreshes += 1;
              expect(credential.access === invalidAccessToken).toBe(true);
              expect(credential.refresh === placeholderRefresh).toBe(true);
              const lockEntries = await fs.readdir(
                path.join(root, "state", "locks", "oauth-refresh"),
              );
              expect(lockEntries.some((entry) => entry.endsWith(".lock"))).toBe(true);
              return {
                ...credential,
                access: accessToken,
                expires: Date.now() + 60 * 60_000,
              };
            },
          },
        });
        setActivePluginRegistry(registry, "codex-auth-boundary-live");
        try {
          const runtime = resolveCodexAppServerRuntimeOptions({
            pluginConfig: {
              appServer: {
                homeScope: "local",
              },
            },
            env: process.env,
          });
          const workspace = path.join(root, "workspace");
          await fs.mkdir(workspace, { recursive: true });
          let refreshRequests = 0;
          const client = await createIsolatedCodexAppServerClient({
            startOptions: {
              ...runtime.start,
              clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
            },
            agentDir,
            authProfileId: profileId,
            authProfileStore: store,
            authRequirement: "subscription",
            timeoutMs: 120_000,
            onStartedClient: (startedClient) => {
              startedClient.addRequestHandler((request) => {
                if (request.method === "account/chatgptAuthTokens/refresh") {
                  refreshRequests += 1;
                }
                return undefined;
              });
            },
          });
          try {
            const listed = await client.request<CodexModelListResponse>(
              "model/list",
              { limit: 100, cursor: null, includeHidden: false },
              { timeoutMs: 60_000 },
            );
            const modelId =
              listed.data.find((model) => model.isDefault)?.model ?? listed.data[0]?.model;
            if (!modelId) {
              throw new Error("Codex model/list returned no models");
            }

            let complete!: (value: CodexTurnCompletedNotification) => void;
            const completed = new Promise<CodexTurnCompletedNotification>((resolve) => {
              complete = resolve;
            });
            client.addNotificationHandler((notification) => {
              if (notification.method === "turn/completed") {
                complete(notification.params as CodexTurnCompletedNotification);
              }
            });
            const started = await client.request(
              "thread/start",
              {
                model: modelId,
                cwd: workspace,
                approvalPolicy: "never",
                sandbox: "read-only",
                threadSource: "user",
              },
              { timeoutMs: 120_000 },
            );
            await client.request(
              "turn/start",
              {
                threadId: started.thread.id,
                input: [{ type: "text", text: "Reply with exactly LIVE_REFRESH_OK." }],
              },
              { timeoutMs: 120_000 },
            );
            const result = await Promise.race([
              completed,
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("live refresh turn timed out")), 180_000).unref();
              }),
            ]);
            expect(result.turn.status).toBe("completed");
            expect(JSON.stringify(result.turn.items)).toContain("LIVE_REFRESH_OK");
            expect(refreshRequests).toBe(1);
            expect(providerRefreshes).toBe(1);
            const runtimeProfile = store.profiles[profileId];
            if (runtimeProfile?.type !== "oauth") {
              throw new Error("expected runtime OAuth profile after refresh");
            }
            expect(runtimeProfile.access === accessToken).toBe(true);
            expect(runtimeProfile.refresh === placeholderRefresh).toBe(true);
            const persistedStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
            const persistedProfile = persistedStore.profiles[profileId];
            if (persistedProfile?.type !== "oauth") {
              throw new Error("expected persisted OAuth profile after refresh");
            }
            expect(persistedProfile.access === accessToken).toBe(true);
            expect(persistedProfile.refresh === placeholderRefresh).toBe(true);
          } finally {
            await client.closeAndWait();
          }
        } finally {
          resetPluginRuntimeStateForTest();
        }
      });
    });
  }, 300_000);
});
