import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
} from "./auth-profiles.js";

describe("external CLI credential sync", () => {
  it("upgrades token to oauth when Claude Code CLI gets refreshToken", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-cli-upgrade-"));
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Claude Code CLI credentials with refreshToken
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "new-oauth-access",
                refreshToken: "new-refresh-token",
                expiresAt: Date.now() + 60 * 60 * 1000,
              },
            }),
          );

          // Create auth-profiles.json with existing token type credential
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "token",
                  provider: "anthropic",
                  token: "old-token",
                  expires: Date.now() + 30 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);

          // Should upgrade from token to oauth
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe("new-oauth-access");
          expect((cliProfile as { refresh: string }).refresh).toBe("new-refresh-token");
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
  it("syncs Codex CLI credentials into openai-codex:codex-cli", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-codex-sync-"));
    try {
      await withTempHome(
        async (tempHome) => {
          // Create Codex CLI credentials
          const codexDir = path.join(tempHome, ".codex");
          fs.mkdirSync(codexDir, { recursive: true });
          const codexCreds = {
            tokens: {
              access_token: "codex-access-token",
              refresh_token: "codex-refresh-token",
            },
          };
          const codexAuthPath = path.join(codexDir, "auth.json");
          fs.writeFileSync(codexAuthPath, JSON.stringify(codexCreds));

          // Create empty auth-profiles.json
          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {},
            }),
          );

          const store = ensureAuthProfileStore(agentDir);

          expect(store.profiles[CODEX_CLI_PROFILE_ID]).toBeDefined();
          expect((store.profiles[CODEX_CLI_PROFILE_ID] as { access: string }).access).toBe(
            "codex-access-token",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
