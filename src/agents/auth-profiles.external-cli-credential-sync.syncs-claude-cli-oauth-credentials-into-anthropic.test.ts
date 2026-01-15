import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { CLAUDE_CLI_PROFILE_ID, ensureAuthProfileStore } from "./auth-profiles.js";

describe("external CLI credential sync", () => {
  it("syncs Claude Code CLI OAuth credentials into anthropic:claude-cli", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-cli-sync-"));
    try {
      // Create a temp home with Claude Code CLI credentials
      await withTempHome(
        async (tempHome) => {
          // Create Claude Code CLI credentials with refreshToken (OAuth)
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          const claudeCreds = {
            claudeAiOauth: {
              accessToken: "fresh-access-token",
              refreshToken: "fresh-refresh-token",
              expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
            },
          };
          fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify(claudeCreds));

          // Create empty auth-profiles.json
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                "anthropic:default": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "sk-default",
                },
              },
            }),
          );

          // Load the store - should sync from CLI as OAuth credential
          const store = ensureAuthProfileStore(agentDir);

          expect(store.profiles["anthropic:default"]).toBeDefined();
          expect((store.profiles["anthropic:default"] as { key: string }).key).toBe("sk-default");
          expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
          // Should be stored as OAuth credential (type: "oauth") for auto-refresh
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe("fresh-access-token");
          expect((cliProfile as { refresh: string }).refresh).toBe("fresh-refresh-token");
          expect((cliProfile as { expires: number }).expires).toBeGreaterThan(Date.now());
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
  it("syncs Claude Code CLI credentials without refreshToken as token type", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-cli-token-sync-"));
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Claude Code CLI credentials WITHOUT refreshToken (fallback to token type)
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          const claudeCreds = {
            claudeAiOauth: {
              accessToken: "access-only-token",
              // No refreshToken - backward compatibility scenario
              expiresAt: Date.now() + 60 * 60 * 1000,
            },
          };
          fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify(claudeCreds));

          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(authPath, JSON.stringify({ version: 1, profiles: {} }));

          const store = ensureAuthProfileStore(agentDir);

          expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toBeDefined();
          // Should be stored as token type (no refresh capability)
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("token");
          expect((cliProfile as { token: string }).token).toBe("access-only-token");
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
