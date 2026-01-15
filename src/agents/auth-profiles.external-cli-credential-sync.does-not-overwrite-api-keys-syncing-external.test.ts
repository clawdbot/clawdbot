import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { CLAUDE_CLI_PROFILE_ID, ensureAuthProfileStore } from "./auth-profiles.js";

describe("external CLI credential sync", () => {
  it("does not overwrite API keys when syncing external CLI creds", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-no-overwrite-"));
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Claude Code CLI credentials
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          const claudeCreds = {
            claudeAiOauth: {
              accessToken: "cli-access",
              refreshToken: "cli-refresh",
              expiresAt: Date.now() + 30 * 60 * 1000,
            },
          };
          fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify(claudeCreds));

          // Create auth-profiles.json with an API key
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                "anthropic:default": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-store",
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);

          // Should keep the store's API key and still add the CLI profile.
          expect((store.profiles["anthropic:default"] as { key: string }).key).toBe("sk-store");
          expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
  it("prefers oauth over token even if token has later expiry (oauth enables auto-refresh)", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-cli-oauth-preferred-"));
    try {
      await withTempHome(
        async (tempHome) => {
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          // CLI has OAuth credentials (with refresh token) expiring in 30 min
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "cli-oauth-access",
                refreshToken: "cli-refresh",
                expiresAt: Date.now() + 30 * 60 * 1000,
              },
            }),
          );

          const authPath = path.join(agentDir, "auth-profiles.json");
          // Store has token credentials expiring in 60 min (later than CLI)
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "token",
                  provider: "anthropic",
                  token: "store-token-access",
                  expires: Date.now() + 60 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          // OAuth should be preferred over token because it can auto-refresh
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe("cli-oauth-access");
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
